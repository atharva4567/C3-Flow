import sys
import os
import struct

# Speed over quality
MODEL_SIZE = "tiny.en"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"

def log(msg):
    print(f"[Python] {msg}", file=sys.stderr, flush=True)

def install_dependencies():
    deps = ["faster-whisper", "numpy"]
    for dep in deps:
        try:
            if dep == "faster-whisper": import faster_whisper
            elif dep == "numpy": import numpy
        except ImportError:
            log(f"{dep} not found. Installing...")
            import subprocess
            subprocess.check_call([sys.executable, "-m", "pip", "install", dep, "--quiet"])

def main():
    install_dependencies()
    from faster_whisper import WhisperModel
    import numpy as np
    log(f"Loading model {MODEL_SIZE}...")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    log("Model loaded. Ready for PCM stream.")

    while True:
        try:
            # Read 1 byte command type
            type_byte = sys.stdin.buffer.read(1)
            if not type_byte: break
            
            cmd = type_byte[0]
            if cmd == 0x01: # START
                audio_data = bytearray()
                while True:
                    # Read next packet type
                    t_byte = sys.stdin.buffer.read(1)
                    if not t_byte: break
                    
                    t = t_byte[0]
                    if t == 0x03: # END
                        break
                    elif t == 0x02: # AUDIO
                        # Read 4 bytes length
                        len_bytes = sys.stdin.buffer.read(4)
                        if not len_bytes: break
                        size = struct.unpack('<I', len_bytes)[0]
                        # Read data
                        chunk = sys.stdin.buffer.read(size)
                        audio_data.extend(chunk)
                    else:
                        log(f"Unknown sub-command: {t}")
                        break

                if audio_data:
                    audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
                    segments, _ = model.transcribe(audio_np, beam_size=1, vad_filter=True)
                    for segment in segments:
                        text = segment.text.strip()
                        if text:
                            print(text, flush=True)
                
                print("TRANSCRIBED_FINISH", flush=True)

        except Exception as e:
            log(f"Error: {e}")
            break

if __name__ == "__main__":
    main()
