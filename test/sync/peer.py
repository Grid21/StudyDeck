# Test helper: acts like ANOTHER Anki device (the real Anki program code) talking to a sync server.
# usage: peer.py <collection> <endpoint> up | change [good|again] | inspect
import sys, os, json, time
from anki.collection import Collection
from anki.cards import Card
from anki.scheduler.v3 import CardAnswer

path, endpoint, mode = sys.argv[1], sys.argv[2], sys.argv[3]
arg = sys.argv[4] if len(sys.argv) > 4 else 'good'
if mode == 'up' and os.path.exists(path): os.remove(path)
col = Collection(path)

def sync():
    auth = col.sync_login('u', 'p', endpoint)
    out = col.sync_collection(auth, sync_media=False)
    if out.required in (out.FULL_SYNC, out.FULL_UPLOAD, out.FULL_DOWNLOAD):
        col.close_for_full_sync()
        col.full_upload_or_download(auth=auth, server_usn=None, upload=(mode == 'up'))
        col.reopen(after_full_sync=True)
    return out

if mode == 'up':
    m = col.models.by_name('Basic'); d = col.decks.id('Korean::Greetings')
    for f, b in [('안녕하세요', 'Hello'), ('감사합니다', 'Thank you'), ('잘 가요', 'Goodbye')]:
        n = col.new_note(m); n['Front'] = f; n['Back'] = b; col.add_note(n, d)
    sync()
elif mode == 'change':
    sync()
    n = col.find_notes('Front:감사합니다')
    note = col.get_note(n[0]); note['Back'] = 'Thank you (edited on the other device)'; col.update_note(note)
    col.decks.select(col.decks.id('Korean::Greetings'))
    target = col.find_cards('Front:"잘 가요"')[0]
    card = col.get_card(target); card.start_timer()
    col.sched.answer_card(col.sched.build_answer(card=card, states=col._backend.get_scheduling_states(target), rating=CardAnswer.GOOD))
    sync()
elif mode == 'studycard':      # answer one specific card (front text in arg2) with Good
    sync()
    front = sys.argv[5]
    col.decks.select(col.decks.id('Korean::Greetings'))
    cid = col.find_cards(f'Front:"{front}"')[0]
    card = col.get_card(cid); card.start_timer()
    # make this card the next one by answering through the scheduler states of its own
    col.sched.answer_card(col.sched.build_answer(card=card, states=col._backend.get_scheduling_states(cid), rating=CardAnswer.GOOD))
    sync()
elif mode == 'inspect':
    sync()
    cards = []
    for cid in col.find_cards(''):
        c = col.get_card(cid); n = c.note()
        cards.append({'front': n['Front'], 'back': n['Back'], 'type': c.type, 'queue': c.queue, 'due': c.due, 'ivl': c.ivl, 'factor': c.factor, 'reps': c.reps, 'lapses': c.lapses, 'mod': c.mod})
    rev = [dict(zip(['id', 'cid', 'usn', 'ease', 'ivl', 'lastIvl', 'factor', 'time', 'type'], r)) for r in col.db.all('select id,cid,usn,ease,ivl,lastIvl,factor,time,type from revlog order by id')]
    print('RESULT ' + json.dumps({'cards': sorted(cards, key=lambda x: x['front']), 'revlog': rev}, ensure_ascii=False))
col.close()
