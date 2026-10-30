import json
import logging
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import soundfile as sf
import torch
from omnivoice import OmniVoice

HOST, PORT = "127.0.0.1", 8765
MODEL_ID = "k2-fsa/OmniVoice"
DEVICE = "cuda:0"
REFERENCE_AUDIO = Path(r"D:\AI\LocalCompanion\omnivoice\lumi-reference.wav")
REFERENCE_TEXT = (
    "Now that you're here, come--sit with me. Hmm? Why you? Why this spot? "
    "Just a sudden urge, I suppose. I wanted to stretch a little closer to "
    "the moon with someone who carries a certain weight. The Tetragon "
    "Temple's architecture is intricate."
)
NUM_STEPS, SAMPLE_RATE = 24, 24000

logging.basicConfig(level=logging.INFO, format="%(asctime)s [Lumi OmniVoice] %(levelname)s: %(message)s")
_model = None
_generation_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logging.info("%s - %s", self.address_string(), fmt % args)

    def reply_json(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply_json(200, {"status": "ready" if _model is not None else "loading"})
        else:
            self.reply_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            self.reply_json(404, {"error": "Not found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 100_000:
                self.reply_json(400, {"error": "Invalid request size"})
                return
            data = json.loads(self.rfile.read(size).decode("utf-8"))
            text = str(data.get("text", "")).strip()
            if not text:
                self.reply_json(400, {"error": "Text is required"})
                return
            text = text[:1200]

            # Serialize access to the single loaded GPU model.
            with _generation_lock:
                audio = _model.generate(
                    text=text,
                    ref_audio=str(REFERENCE_AUDIO),
                    ref_text=REFERENCE_TEXT,
                    num_step=NUM_STEPS,
                )

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                wav_path = Path(f.name)
            try:
                sf.write(str(wav_path), audio[0], SAMPLE_RATE, subtype="PCM_16")
                wav = wav_path.read_bytes()
            finally:
                wav_path.unlink(missing_ok=True)

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except (BrokenPipeError, ConnectionResetError):
            logging.info("Client disconnected before audio delivery.")
        except Exception as exc:
            logging.exception("Synthesis failed")
            try:
                self.reply_json(500, {"error": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    global _model
    if not REFERENCE_AUDIO.is_file():
        raise FileNotFoundError(REFERENCE_AUDIO)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; check the NVIDIA driver and PyTorch.")
    logging.info("Loading %s on %s (one time per service start)", MODEL_ID, DEVICE)
    _model = OmniVoice.from_pretrained(MODEL_ID, device_map=DEVICE, dtype=torch.float16)
    logging.info("Model ready; listening on http://%s:%d", HOST, PORT)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
