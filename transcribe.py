import sys
import os
import traceback

def log(msg):
    # Print to stderr to ensure it's captured separate from transcription output
    print(f"[transcribe.py] {msg}", file=sys.stderr)

def install_and_import():
    try:
        log("Attempting to import faster_whisper...")
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        log("faster_whisper not found. Installing via pip...")
        try:
            import subprocess
            subprocess.check_call([sys.executable, "-m", "pip", "install", "faster-whisper", "--quiet"])
            log("Installation successful.")
            from faster_whisper import WhisperModel
            return WhisperModel
        except Exception as e:
            log(f"FATAL: Failed to install faster-whisper: {e}")
            sys.exit(1)

def main():
    try:
        log(f"Python Executable: {sys.executable}")
        log(f"Arguments: {sys.argv}")

        if len(sys.argv) < 2:
            log("Error: Missing audio file path argument.")
            print("USAGE_ERROR", file=sys.stdout) # helping main.js detect
            sys.exit(1)

        audio_path = sys.argv[1]
        
        if not os.path.exists(audio_path):
            log(f"Error: File does not exist: {audio_path}")
            sys.exit(1)

        # Import Model
        WhisperModel = install_and_import()
        
        # Load Model - OPTIMIZED FOR SPEED
        model_size = "tiny.en"  # Fastest model, ~2x faster than base.en
        log(f"Loading model '{model_size}' on CPU...")
        
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        
        log("Transcribing...")
        segments, info = model.transcribe(audio_path, beam_size=1, vad_filter=True)
        
        # EARLY COMMIT: Print each segment immediately as it becomes available
        for segment in segments:
            text = segment.text.strip()
            if text:
                print(text, file=sys.stdout, flush=True)  # Flush immediately for early commit
        
        # Signal completion (empty line or just exit)
        
    except Exception:
        log("An unhandled exception occurred:")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
