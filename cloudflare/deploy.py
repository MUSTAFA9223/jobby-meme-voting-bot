"""Deploy and migrate on GitHub's runner. Never print credentials or API bodies."""
import json
import hashlib
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import urllib.request

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
    result = subprocess.run(['npx', '--no-install', 'wrangler', *args], cwd=ROOT,
        input=input_text, text=True, capture_output=True)
    if result.returncode:
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
    webhook_secret = secrets.token_hex(32)
    wrangler('secret', 'bulk', '--config', 'wrangler.deploy.json', input_text=json.dumps({
        'JOBBY_BOT_TOKEN': BOT_TOKEN, 'JOBBY_WEBHOOK_SECRET': webhook_secret,
        'JOBBY_ADMIN_IDS': os.environ['JOBBY_ADMIN_IDS'],
        'JOBBY_REQUIRED_CHAT_ID': os.environ.get('JOBBY_REQUIRED_CHAT_ID', '')}))
    subdomain = cf('/workers/subdomain')['subdomain']
    url = 'https://jobby-meme-voting.' + subdomain + '.workers.dev'
    with urllib.request.urlopen(url + '/health', timeout=30) as response:
        if response.status != 200:
            raise RuntimeError('Worker health check failed; webhook unchanged')
    telegram('setWebhook', {'url': url + '/webhook', 'secret_token': webhook_secret,
        'max_connections': 1, 'allowed_updates': ['message', 'callback_query'], 'drop_pending_updates': False})
    info = telegram('getWebhookInfo', {})
    if info.get('url') != url + '/webhook' or info.get('max_connections') != 1:
        raise RuntimeError('Webhook configuration verification failed')
    # A real Telegram API delivery check to the configured organizer, not the community.
    telegram('sendMessage', {'chat_id': 8355389673,
        'text': '✅ JOBBY يعمل الآن على Cloudflare. أرسل /start ثم جرّب /add وإرسال صورة للتحقق من سرعة الرد.'})
    print('Cloudflare deployed and healthy; Telegram webhook configured and organizer test message delivered.')
    print('Worker: ' + url)
    print('Send /start and a photo to verify end-to-end Telegram delivery.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # No stack trace: urllib exceptions and subprocess output may embed secrets.
        print('Deployment stopped: ' + str(exc) if isinstance(exc, RuntimeError) else 'Deployment stopped; private error details suppressed.')
        raise SystemExit(1) from None
