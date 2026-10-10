"""Deploy and migrate on GitHub's runner. Never print credentials or API bodies."""
import json
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.request
import urllib.error
import re

ROOT = Path(__file__).resolve().parent
CF_TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
BOT_TOKEN = os.environ['JOBBY_BOT_TOKEN']
ACCOUNT = ''


def cf_api(url, payload=None, method=None):
    req = urllib.request.Request(url,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.load(response)
        if not data.get('success'):
            raise RuntimeError()
        return data['result']
    except Exception:
        raise RuntimeError('Cloudflare request failed; response suppressed to protect secrets') from None


def cf(path, payload=None, method=None):
    return cf_api('https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + path,
                  payload, method)


def telegram(method, payload):
    req = urllib.request.Request('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method,
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.load(response)
        if not data.get('ok'):
            raise RuntimeError()
        return data['result']
    except Exception:
        raise RuntimeError('Telegram request failed; response suppressed to protect bot token') from None


def wrangler(*args, input_text=None):
    # CLI output can contain URLs or user data. Only emit our fixed status messages.
    command_env = os.environ.copy()
    command_env['CLOUDFLARE_ACCOUNT_ID'] = ACCOUNT
    result = subprocess.run(['npx', '--no-install', 'wrangler', *args], cwd=ROOT,
        input=input_text, text=True, capture_output=True, env=command_env)
    if result.returncode:
        diagnostic = '\n'.join((result.stdout + '\n' + result.stderr).splitlines()[-12:])
        for value in (CF_TOKEN, BOT_TOKEN, os.environ.get('STATE_KEY', ''), ACCOUNT):
            if value:
                diagnostic = diagnostic.replace(value, '[redacted]')
        diagnostic = re.sub(r'https?://\S+', '[redacted-url]', diagnostic)
        diagnostic = re.sub(r'[\w.+-]+@[\w.-]+', '[redacted-email]', diagnostic)
        diagnostic = re.sub(r'[A-Za-z0-9_-]{24,}', '[redacted-id]', diagnostic)
        print('Wrangler diagnostic (sanitized):\n' + diagnostic)
        raise RuntimeError('Wrangler operation failed; credential-bearing output suppressed')


def main():
    global ACCOUNT
    accounts = cf_api('https://api.cloudflare.com/client/v4/accounts?per_page=100')
    if len(accounts) != 1:
        raise RuntimeError('Cloudflare token must be limited to exactly one account')
    ACCOUNT = accounts[0]['id']
    with sqlite3.connect(os.environ['DB_PATH']) as snapshot:
        if snapshot.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Encrypted contest snapshot integrity check failed')
    identity = telegram('getMe', {})
    if identity.get('username') != 'JOBBYMemeVoteBot':
        raise RuntimeError('Unexpected bot identity; deployment stopped')
    databases = cf('/d1/database?per_page=100')
    matches = [d for d in databases if d['name'] == 'jobby-meme-voting']
    if len(matches) > 1:
        raise RuntimeError('Ambiguous database name')
    database = matches[0] if matches else cf('/d1/database', {'name': 'jobby-meme-voting'})
    database_id = database['uuid']
    endpoint = '/d1/database/' + database_id + '/query'
    schema = (ROOT / 'schema.sql').read_text()
    for statement in schema.split(';'):
        if statement.strip():
            cf(endpoint, {'sql': statement})
    entry_columns = cf(endpoint, {'sql': 'PRAGMA table_info(entries)'})[0]['results']
    if not any(column['name'] == 'media_type' for column in entry_columns):
        cf(endpoint, {'sql': "ALTER TABLE entries ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo' CHECK(media_type IN ('photo','video','animation'))"})
    vote_columns = cf(endpoint, {'sql': 'PRAGMA table_info(votes)'})[0]['results']
    vote_primary_key = [column['name'] for column in sorted(
        (column for column in vote_columns if column['pk']), key=lambda column: column['pk'])]
    legacy_votes = cf(endpoint, {'sql': "SELECT name FROM sqlite_master WHERE type='table' AND name='votes_single_choice'"})[0]['results']
    if vote_primary_key == ['user_id', 'entry_id'] and legacy_votes:
        # Resume safely if a previous deployment stopped partway through the
        # table replacement.
        cf(endpoint, {'sql': '''INSERT OR IGNORE INTO votes(user_id,entry_id,updated_at)
            SELECT user_id,entry_id,updated_at FROM votes_single_choice'''})
        cf(endpoint, {'sql': 'DROP INDEX IF EXISTS idx_votes_entry'})
        cf(endpoint, {'sql': 'DROP TABLE votes_single_choice'})
        cf(endpoint, {'sql': 'CREATE INDEX IF NOT EXISTS idx_votes_entry ON votes(entry_id)'})
    if vote_primary_key != ['user_id', 'entry_id']:
        # Preserve every existing vote while changing from one global vote to
        # one permanent vote per account and meme. Reruns skip this migration.
        cf(endpoint, {'sql': 'DROP INDEX IF EXISTS idx_votes_entry'})
        cf(endpoint, {'sql': 'ALTER TABLE votes RENAME TO votes_single_choice'})
        cf(endpoint, {'sql': '''CREATE TABLE votes (
            user_id INTEGER NOT NULL,
            entry_id INTEGER NOT NULL REFERENCES entries(id),
            updated_at TEXT NOT NULL,
            PRIMARY KEY(user_id,entry_id)
        )'''})
        cf(endpoint, {'sql': '''INSERT OR IGNORE INTO votes(user_id,entry_id,updated_at)
            SELECT user_id,entry_id,updated_at FROM votes_single_choice'''})
        cf(endpoint, {'sql': 'DROP TABLE votes_single_choice'})
        cf(endpoint, {'sql': 'CREATE INDEX idx_votes_entry ON votes(entry_id)'})
    # A marker makes reruns safe. Never replace an existing live contest.
    marker = cf(endpoint, {'sql': "SELECT value FROM config WHERE key='github_migrated'"})[0]['results']
    if not marker:
        occupied = cf(endpoint, {'sql': 'SELECT (SELECT COUNT(*) FROM entries)+(SELECT COUNT(*) FROM votes)+(SELECT COUNT(*) FROM ratings)+(SELECT COUNT(*) FROM drafts) AS n'})[0]['results'][0]['n']
        snapshot_hash = hashlib.sha256(Path(os.environ['DB_PATH']).read_bytes()).hexdigest()
        pending = cf(endpoint, {'sql': "SELECT value FROM config WHERE key='github_migration_pending'"})[0]['results']
        if occupied and (not pending or pending[0]['value'] != snapshot_hash):
            raise RuntimeError('Cloudflare database contains unmarked data; migration stopped')
        cf(endpoint, {'sql': "INSERT OR REPLACE INTO config VALUES ('github_migration_pending',?)", 'params': [snapshot_hash]})
        db = sqlite3.connect(os.environ['DB_PATH'])
        try:
            # The snapshot is frozen by the shared workflow concurrency group.
            # Each table insert is idempotent, preserving IDs, timestamps and drafts.
            for table in ('entries', 'votes', 'ratings', 'config', 'drafts'):
                columns = [row[1] for row in db.execute('PRAGMA table_info(' + table + ')')]
                for row in db.execute('SELECT * FROM ' + table):
                    placeholders = ','.join('?' for _ in columns)
                    cf(endpoint, {'sql': f"INSERT OR REPLACE INTO {table} ({','.join(columns)}) VALUES ({placeholders})", 'params': list(row)})
            cf(endpoint, {'sql': "INSERT INTO config VALUES ('github_migrated','1')"})
            cf(endpoint, {'sql': "DELETE FROM config WHERE key='github_migration_pending'"})
        finally:
            db.close()
    print('Contest database ready; existing entries, votes and drafts preserved.')
    config = (ROOT / 'wrangler.jsonc').read_text().replace('REPLACE_WITH_D1_DATABASE_ID', database_id)
    (ROOT / 'wrangler.deploy.json').write_text(config)
    wrangler('deploy', '--config', 'wrangler.deploy.json')
    print('Worker code uploaded.')
    webhook_secret = hashlib.sha256(
        (os.environ['STATE_KEY'] + ':jobby-webhook-v1').encode()).hexdigest()
    worker_secrets = {
        'JOBBY_BOT_TOKEN': BOT_TOKEN,
        'JOBBY_WEBHOOK_SECRET': webhook_secret,
    }
    required_chat = os.environ.get('JOBBY_REQUIRED_CHAT_ID', '').strip()
    if required_chat:
        worker_secrets['JOBBY_REQUIRED_CHAT_ID'] = required_chat
    wrangler('secret', 'bulk', '--config', 'wrangler.deploy.json',
             input_text=json.dumps(worker_secrets))
    print('Worker secrets configured.')
    subdomain_info = cf('/workers/subdomain')
    if not isinstance(subdomain_info, dict) or not subdomain_info.get('subdomain'):
        raise RuntimeError('Cloudflare workers.dev subdomain is not configured')
    subdomain = subdomain_info['subdomain']
    url = 'https://jobby-meme-voting.' + subdomain + '.workers.dev'
    healthy = False
    health_diagnostic = 'no response'
    for _ in range(6):
        try:
            health_request = urllib.request.Request(url + '/health', headers={
                'User-Agent': 'Mozilla/5.0 (compatible; JOBBY-Health/1.0)',
                'Accept': 'text/plain',
            })
            with urllib.request.urlopen(health_request, timeout=30) as response:
                healthy = response.status == 200
                health_diagnostic = 'HTTP ' + str(response.status)
        except urllib.error.HTTPError as exc:
            body = exc.read(160).decode('utf-8', 'replace')
            health_diagnostic = 'HTTP ' + str(exc.code) + ': ' + re.sub(r'[^A-Za-z0-9 ._-]', '', body)
            healthy = False
        except Exception:
            health_diagnostic = 'transport failure'
            healthy = False
        if healthy:
            break
        time.sleep(3)
    if not healthy:
        print('Worker health diagnostic: ' + health_diagnostic)
        raise RuntimeError('Worker health check failed after deployment; webhook unchanged')
    print('Worker health check passed.')
    telegram('setWebhook', {'url': url + '/webhook', 'secret_token': webhook_secret,
        'max_connections': 1, 'allowed_updates': ['message', 'channel_post', 'callback_query', 'my_chat_member'], 'drop_pending_updates': False})
    info = telegram('getWebhookInfo', {})
    if info.get('url') != url + '/webhook' or info.get('max_connections') != 1:
        raise RuntimeError('Webhook configuration verification failed')
    print('Telegram webhook configured and verified.')
    telegram('setMyCommands', {'scope': {'type': 'all_private_chats'}, 'commands': [
        {'command': 'start', 'description': 'Open JOBBY voting'},
        {'command': 'add', 'description': 'Add a photo, video, or GIF meme'},
        {'command': 'entries', 'description': 'Browse contest entries'},
        {'command': 'leaderboard', 'description': 'Show current leaderboard'},
        {'command': 'publish', 'description': 'Publish an entry to a connected chat'},
        {'command': 'destinations', 'description': 'List connected groups and channels'},
        {'command': 'admin', 'description': 'Show organizer controls'},
        {'command': 'rules', 'description': 'Show contest rules'},
        {'command': 'language', 'description': 'العربية / English'},
        {'command': 'cancel', 'description': 'Cancel the current draft'},
    ]})
    telegram('setMyCommands', {'scope': {'type': 'all_group_chats'}, 'commands': [
        {'command': 'register', 'description': 'Connect this group to JOBBY voting'},
        {'command': 'unregister', 'description': 'Disconnect this group'},
        {'command': 'myid', 'description': 'Show your Telegram ID'},
    ]})
    telegram('setMyCommands', {'scope': {'type': 'all_private_chats'}, 'language_code': 'ar', 'commands': [
        {'command': 'start', 'description': 'فتح تصويت JOBBY'},
        {'command': 'add', 'description': 'إضافة صورة أو فيديو أو GIF'},
        {'command': 'entries', 'description': 'تصفح مشاركات المسابقة'},
        {'command': 'leaderboard', 'description': 'عرض المتصدرين'},
        {'command': 'publish', 'description': 'نشر مشاركة في مجموعة أو قناة'},
        {'command': 'destinations', 'description': 'عرض وجهات النشر المتصلة'},
        {'command': 'admin', 'description': 'عرض أدوات الإدارة'},
        {'command': 'rules', 'description': 'عرض قواعد المسابقة'},
        {'command': 'language', 'description': 'العربية / English'},
        {'command': 'cancel', 'description': 'إلغاء المسودة الحالية'},
    ]})
    telegram('setMyCommands', {'scope': {'type': 'all_group_chats'}, 'language_code': 'ar', 'commands': [
        {'command': 'register', 'description': 'ربط المجموعة بتصويت JOBBY'},
        {'command': 'unregister', 'description': 'فصل المجموعة'},
        {'command': 'myid', 'description': 'عرض معرّف تيليجرام'},
    ]})
    print('Telegram command menus configured.')
    self_test_id = int(time.time() * 1000)
    self_test = {
        'update_id': self_test_id,
        'message': {
            'message_id': self_test_id,
            'date': int(time.time()),
            'chat': {'id': 8355389673, 'type': 'private'},
            'from': {'id': 8355389673, 'is_bot': False, 'first_name': 'JOBBY Admin', 'language_code': 'ar'},
            'text': '/start',
        },
    }
    self_test_diagnostic = 'no response'
    self_test_passed = False
    for _ in range(10):
        self_test_request = urllib.request.Request(url + '/webhook',
            data=json.dumps(self_test).encode(), method='POST', headers={
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; JOBBY-Webhook-Test/1.0)',
                'X-Telegram-Bot-Api-Secret-Token': webhook_secret,
            })
        try:
            with urllib.request.urlopen(self_test_request, timeout=30) as response:
                self_test_passed = response.status == 200
                self_test_diagnostic = 'HTTP ' + str(response.status)
        except urllib.error.HTTPError as exc:
            body = exc.read(160).decode('utf-8', 'replace')
            safe_body = re.sub(r'[^A-Za-z0-9 ._-]', '', body)
            self_test_diagnostic = 'HTTP ' + str(exc.code) + ': ' + safe_body
        except Exception:
            self_test_diagnostic = 'transport failure'
        if self_test_passed:
            break
        time.sleep(3)
    if not self_test_passed:
        raise RuntimeError('Worker webhook self-test failed: ' + self_test_diagnostic)
    print('Worker webhook self-test passed; organizer welcome delivered through the Worker.')
    # A real Telegram API delivery check to the configured organizer, not the community.
    telegram('sendMessage', {'chat_id': 8355389673,
        'text': '✅ JOBBY يعمل الآن على Cloudflare ويدعم الصور والفيديو وGIF. أرسل /start ثم جرّب /add.'})
    print('Cloudflare deployed and healthy; Telegram webhook configured and organizer test message delivered.')
    print('Worker: ' + url)
    print('Send /start and a photo, video, or GIF to verify end-to-end Telegram delivery.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # No stack trace: urllib exceptions and subprocess output may embed secrets.
        print('Deployment stopped: ' + str(exc) if isinstance(exc, RuntimeError) else 'Deployment stopped; private error details suppressed.')
        raise SystemExit(1) from None
