import os
import io
import pickle
import numpy as np
import librosa
import soundfile as sf
from fastapi import FastAPI, File, UploadFile, HTTPException, WebSocket
from fastapi.responses import JSONResponse
import tensorflow as tf
from collections import deque
from fastapi.middleware.cors import CORSMiddleware

# ==============================
# Load model + label encoder
# ==============================
MODEL_PATH = "models/final_emotion_model.keras"
ENCODER_PATH = "models/label_encoder.pkl"

model = tf.keras.models.load_model(MODEL_PATH)
with open(ENCODER_PATH, "rb") as f:
    label_encoder = pickle.load(f)

app = FastAPI(title="Speech Emotion Recognition API")

# Enable CORS for all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allow all HTTP methods (GET, POST, etc.)
    allow_headers=["*"],  # Allow all headers
)

# ---------- Feature Extraction ----------
def extract_logmel_from_array(y, sr=22050, n_mels=64, max_duration=3.0, max_frames=129):
    try:
        target_len = int(sr * max_duration)
        if len(y) < target_len:
            y = np.pad(y, (0, target_len - len(y)))
        else:
            y = y[:target_len]

        mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=n_mels)
        logmel = librosa.power_to_db(mel)
        logmel = (logmel - np.mean(logmel)) / (np.std(logmel) + 1e-6)

        if logmel.shape[1] < max_frames:
            pad_width = max_frames - logmel.shape[1]
            logmel = np.pad(logmel, ((0, 0), (0, pad_width)), mode="constant")
        else:
            logmel = logmel[:, :max_frames]

        return np.expand_dims(logmel, -1)
    except Exception as e:
        print(f"⚠️ Feature extraction failed: {e}")
        return None


# ---------- REST Prediction Endpoint ----------
@app.post("/predict")
async def predict_emotion(file: UploadFile = File(...)):
    """
    Accepts ANY audio file (wav, mp3, webm, ogg, m4a, etc).
    Uses librosa for loading, so decoding is robust.
    Returns emotion+confidence% or error.
    """
    import tempfile
    temp_path = None
    try:
        # Save incoming file to a secure temp file
        suffix = os.path.splitext(file.filename)[-1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await file.read())
            temp_path = tmp.name

        # Robust audio loading (let librosa handle actual format)
        y, sr = librosa.load(temp_path, sr=22050, duration=3.0)

        feat = extract_logmel_from_array(y, sr=sr)
        if feat is None:
            raise HTTPException(status_code=500, detail="Failed to extract features from audio.")

        feat = np.expand_dims(feat, 0)
        pred = model.predict(feat)
        pred_class = np.argmax(pred, axis=1)[0]
        pred_label = label_encoder.inverse_transform([pred_class])[0]
        confidence = float(np.max(pred))

        return {
            "emotion": pred_label,
            "confidence": int(round(confidence * 100))
        }
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Cannot process audio: {str(e)}")
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass


# ---------- WebSocket Realtime Prediction ----------
import av  # PyAV
import numpy as np
import soundfile as sf
import tempfile

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    Accepts binary audio chunks (WebM/Opus recommended), decodes and predicts.
    Robust error handling and temp file cleanup.
    Returns {"emotion": ..., "confidence": ...} or {"error": ...}
    """
    import tempfile
    await ws.accept()
    print("🎤 WebSocket client connected")
    try:
        while True:
            temp_path = None
            try:
                data = await ws.receive_bytes()
                with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
                    tmp.write(data)
                    temp_path = tmp.name

                try:
                    container = av.open(temp_path)
                    audio_frames = []
                    for frame in container.decode(audio=0):
                        audio_frames.append(frame.to_ndarray().flatten())
                    y = np.concatenate(audio_frames).astype(np.float32)
                    sr = container.streams.audio[0].rate
                    container.close()
                except Exception as e:
                    await ws.send_json({"error": f"Decode error: {str(e)}"})
                    continue

                feat = extract_logmel_from_array(y, sr=sr)
                if feat is None:
                    await ws.send_json({"error": "Feature extraction failed"})
                    continue

                feat = np.expand_dims(feat, 0)
                pred = model.predict(feat, verbose=0)
                pred_class = np.argmax(pred, axis=1)[0]
                pred_label = label_encoder.inverse_transform([pred_class])[0]
                confidence = float(np.max(pred))

                await ws.send_json({
                    "emotion": pred_label,
                    "confidence": int(round(confidence * 100))
                })
            finally:
                if temp_path and os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except Exception:
                        pass

    except Exception as e:
        print(f"⚠️ WebSocket error: {e}")
        try:
            await ws.close()
        except RuntimeError:
            pass
        print("🔌 WebSocket disconnected")


@app.get("/")
async def root():
    return {"message": "Speech Emotion Recognition API is running!"}
