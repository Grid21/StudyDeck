# Test helper: acts like the real Anki program talking to a sync server.  usage: seed.py <collection> <endpoint> up|add
import sys, os, time
from anki.collection import Collection
path, endpoint, mode = sys.argv[1], sys.argv[2], sys.argv[3]
if mode == 'up' and os.path.exists(path): os.remove(path)
col = Collection(path)
if mode == 'up':
    m = col.models.by_name('Basic'); d = col.decks.id('Korean::Greetings')
    for f, b in [('안녕하세요', 'Hello [sound:hello.mp3]'), ('감사합니다', 'Thank you <img src="dot.png">')]:
        n = col.new_note(m); n['Front'] = f; n['Back'] = b; col.add_note(n, d)
    col.media.write_data('hello.mp3', b'ID3\x03\x00\x00\x00\x00\x00\x00fake-mp3-bytes')
    col.media.write_data('dot.png', bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082'))
else:
    m = col.models.by_name('Basic'); d = col.decks.id('Korean::Greetings')
    n = col.new_note(m); n['Front'] = '잘 지냈어요?'; n['Back'] = 'Have you been well?'; col.add_note(n, d)
auth = col.sync_login('u', 'p', endpoint)
out = col.sync_collection(auth, sync_media=False)
if out.required in (out.FULL_SYNC, out.FULL_UPLOAD, out.FULL_DOWNLOAD):
    col.close_for_full_sync()
    col.full_upload_or_download(auth=auth, server_usn=None, upload=True)
    col.reopen(after_full_sync=True)
col.sync_media(auth)
for _ in range(60):
    if not col.media_sync_status().active: break
    time.sleep(0.5)
print('seeded', mode, col.note_count(), 'notes')
col.close()
