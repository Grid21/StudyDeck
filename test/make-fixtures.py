"""Makes real Anki deck files (.apkg) for testing StudyDeck's importer.
Needs:  pip install anki
Run:    python3 test/make-fixtures.py
The generated files are saved in test/fixtures/ and committed, so you only need this to remake them."""
import base64, os, shutil, tempfile, time
from anki.collection import Collection, ExportAnkiPackageOptions, DeckIdLimit

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
os.makedirs(OUT, exist_ok=True)

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def build(legacy: bool, name: str):
    tmp = tempfile.mkdtemp()
    col = Collection(os.path.join(tmp, "collection.anki2"))
    deck_id = col.decks.id("Korean::Basics")
    col.decks.id("Korean::Basics::Verbs")

    png_path = os.path.join(tmp, "dot.png")
    open(png_path, "wb").write(PNG)
    mp3_path = os.path.join(tmp, "hello.mp3")
    open(mp3_path, "wb").write(b"ID3\x03\x00\x00\x00\x00\x00\x00fake-audio")
    png_name = col.media.add_file(png_path)
    mp3_name = col.media.add_file(mp3_path)

    def add(model_name, fields, tags=(), did=deck_id):
        model = col.models.by_name(model_name)
        note = col.new_note(model)
        for k, v in fields.items():
            note[k] = v
        note.tags = list(tags)
        col.add_note(note, did)
        return note

    add("Basic", {"Front": "안녕하세요", "Back": f"Hello <b>(formal)</b><br><img src=\"{png_name}\">"}, ["greetings"])
    add("Basic", {"Front": "감사합니다", "Back": f"Thank you [sound:{mp3_name}]"}, ["greetings"])
    add("Basic (and reversed card)", {"Front": "물", "Back": "water"}, ["nouns"])
    add("Cloze", {"Text": "한국의 수도는 {{c1::서울::city}}이고, 가장 큰 항구도시는 {{c2::부산}}입니다.", "Back Extra": "Capital & port"}, ["geography"])
    add("Basic (type in the answer)", {"Front": "cat", "Back": "고양이"}, ["nouns"])
    add("Basic", {"Front": "먹다", "Back": "to eat"}, ["verbs"], did=col.decks.id("Korean::Basics::Verbs"))

    # make two cards look like they were studied in Anki
    ids = col.find_cards("deck:Korean*")
    for i, cid in enumerate(ids[:2]):
        card = col.get_card(cid)
        card.type = 2
        card.queue = 2
        card.ivl = 10 + i * 5
        card.factor = 2500 - i * 150
        card.reps = 4
        card.lapses = i
        card.due = col.sched.today + 3 + i
        col.update_card(card)
    # one suspended card
    card = col.get_card(ids[-1])
    card.queue = -1
    col.update_card(card)

    out = os.path.join(OUT, name)
    if os.path.exists(out):
        os.remove(out)
    opts = ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=True, with_media=True, legacy=legacy)
    col.export_anki_package(out_path=out, options=opts, limit=DeckIdLimit(deck_id))
    col.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print("made", out, os.path.getsize(out), "bytes")


build(False, "korean-modern.apkg")
build(True, "korean-legacy.apkg")
