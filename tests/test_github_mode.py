import os
import unittest
from unittest.mock import patch
from jobby_bot.bot import MemeBot
from jobby_bot.store import Store
from jobby_bot.api import TelegramError
from tests.test_bot import FakeAPI


class ScriptedAPI(FakeAPI):
    def __init__(self):
        super().__init__()
        self.returned = False

    def call(self, method, **kwargs):
        if method == 'getMe':
            return {'username':'testbot'}
        if method == 'getUpdates':
            if not self.returned:
                self.returned = True
                return [{'update_id': 38, 'message': {'chat': {'id': 99, 'type': 'private'},
                        'from': {'id': 99}, 'text':'/myid'}}]
            return []
        return super().call(method, **kwargs)


class GitHubRunnerTests(unittest.TestCase):
    def test_update_offset_saved_and_reloaded(self):
        store = Store(':memory:')
        self.assertEqual(store.last_update_offset(), 0)
        store.save_update_offset(39)
        self.assertEqual(store.last_update_offset(), 39)
        store.save_update_offset(40)
        self.assertEqual(store.last_update_offset(), 40)
        store.close()

    def test_short_runner_tracks_offset(self):
        store = Store(':memory:')
        api = ScriptedAPI()
        with patch.dict(os.environ, {'RUN_SECONDS':'1'}):
            MemeBot(api, store, {444}).run()
        self.assertEqual(store.last_update_offset(), 39)
        self.assertTrue(any(c[0] == 'send' for c in api.calls))
        store.close()

    def test_expired_callback_not_preventing_vote(self):
        class ExpiredAPI(FakeAPI):
            def ack(self, callback_id, text=''):
                raise TelegramError('Too old')
        store = Store(':memory:')
        api = ExpiredAPI()
        bot = MemeBot(api,store,{444})
        store.create_entry('photo','https://x.com/art/status/12','art','creator',444)
        bot.handle_callback({'id':'expired','data':'vote:1','from': {'id': 333, 'username': 'voter'},
                             'message': {'message_id':1, 'photo':[{'file_id':'1'}],
                              'chat':{'type':'private','id':333}}})
        self.assertEqual(store.vote_for(333),1)
        self.assertTrue(any(c[0] == 'send' and 'Vote recorded' in c[2] for c in api.calls))
        store.close()
