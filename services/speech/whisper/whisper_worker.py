
import sys
import json
import base64
import traceback

import av
import numpy as np
import ctranslate2
from faster_whisper import WhisperModel


# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

SAMPLE_RATE = 48_000
TARGET_RATE = 16_000
CHANNELS = 2
BYTES_PER_SAMPLE = 2

MODEL_NAME = "base"

DEVICE = "cuda"
COMPUTE_TYPE = "float16"
DEVICE_INDEX = 0

# Short commands benefit from faster decoding.
BEAM_SIZE = 2

INITIAL_PROMPT = (
    "Lumi. Hey Lumi. "
    "Lumi is a person's name. "
    "The speaker is talking to Lumi."
)


# --------------------------------------------------
# JSON COMMUNICATION
# --------------------------------------------------

def send(data):
    sys.stdout.write(json.dumps(data, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def log(message):
    print(f"[Whisper] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------
# MODEL
# --------------------------------------------------

def load_model():
    device = DEVICE
    compute_type = COMPUTE_TYPE

    if device == "cuda":
        gpu_count = ctranslate2.get_cuda_device_count()

        if gpu_count <= DEVICE_INDEX:
            log("CUDA unavailable. Falling back to CPU int8.")
            device = "cpu"
            compute_type = "int8"
        else:
            supported = ctranslate2.get_supported_compute_types(
                "cuda",
                DEVICE_INDEX,
            )

            if compute_type not in supported:
                log(
                    f"{compute_type} unsupported. "
                    "Using int8_float16 instead."
                )
                compute_type = "int8_float16"

    log(
        f"Loading {MODEL_NAME} on {device} "
        f"({compute_type})..."
    )

    try:
        model = WhisperModel(
            MODEL_NAME,
            device=device,
            device_index=DEVICE_INDEX if device == "cuda" else 0,
            compute_type=compute_type,
            cpu_threads=4,
            num_workers=1,
        )

    except Exception as error:
        if device != "cuda":
            raise

        log(f"CUDA initialization failed: {error}")
        log("Falling back to CPU int8.")

        device = "cpu"
        compute_type = "int8"

        model = WhisperModel(
            MODEL_NAME,
            device=device,
            compute_type=compute_type,
            cpu_threads=4,
            num_workers=1,
        )

    log(f"Model ready on {device} ({compute_type}).")

    return model, device


# --------------------------------------------------
# AUDIO CONVERSION
# --------------------------------------------------

def convert_to_16khz_mono(pcm_bytes):
    bytes_per_frame = CHANNELS * BYTES_PER_SAMPLE

    usable_length = (
        len(pcm_bytes) // bytes_per_frame
    ) * bytes_per_frame

    pcm_bytes = pcm_bytes[:usable_length]

    if not pcm_bytes:
        return np.empty(0, dtype=np.float32)

    sample_count = len(pcm_bytes) // bytes_per_frame

    frame = av.AudioFrame(
        format="s16",
        layout="stereo",
        samples=sample_count,
    )

    frame.planes[0].update(pcm_bytes)
    frame.sample_rate = SAMPLE_RATE

    resampler = av.AudioResampler(
        format="fltp",
        layout="mono",
        rate=TARGET_RATE,
    )

    converted_frames = resampler.resample(frame)
    converted_frames.extend(resampler.resample(None))

    if not converted_frames:
        return np.empty(0, dtype=np.float32)

    audio = np.concatenate([
        item.to_ndarray().reshape(-1)
        for item in converted_frames
    ])

    return audio.astype(np.float32, copy=False)


# --------------------------------------------------
# TRANSCRIPTION
# --------------------------------------------------

def transcribe(model, pcm_bytes):
    audio = convert_to_16khz_mono(pcm_bytes)

    if audio.size == 0:
        return {
            "text": "",
            "language": None,
            "duration": 0,
        }

    duration = len(audio) / TARGET_RATE

    segments, info = model.transcribe(
        audio,
        language="en",
        beam_size=BEAM_SIZE,
        best_of=1,
        temperature=0.0,
        vad_filter=False,
        condition_on_previous_text=False,
        initial_prompt=INITIAL_PROMPT,
        without_timestamps=True,
    )

    text = "".join(
        segment.text for segment in segments
    ).strip()

    return {
        "text": text,
        "language": info.language,
        "duration": round(duration, 2),
    }


# --------------------------------------------------
# MAIN WORKER
# --------------------------------------------------

def main():
    model, device = load_model()

    send({
        "type": "ready",
        "device": device,
        "model": MODEL_NAME,
    })

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        request_id = None

        try:
            request = json.loads(line)
            request_id = request.get("id")

            if request.get("type") == "shutdown":
                break

            if request.get("type") != "transcribe":
                continue

            encoded_audio = request.get("audio")

            if not encoded_audio:
                raise ValueError("Missing audio data.")

            pcm_bytes = base64.b64decode(
                encoded_audio,
                validate=True,
            )

            result = transcribe(model, pcm_bytes)

            send({
                "type": "transcription",
                "id": request_id,
                **result,
            })

        except Exception as error:
            log(f"Request failed: {error}")
            traceback.print_exc(file=sys.stderr)

            send({
                "type": "error",
                "id": request_id,
                "error": str(error),
            })


if __name__ == "__main__":
    main()
