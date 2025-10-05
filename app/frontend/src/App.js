import React, { useState, useEffect } from "react";
import { FiUpload, FiWifi, FiWifiOff, FiMic, FiSquare } from "react-icons/fi";
import "./App.css";

function App() {
  const [isRealtime, setIsRealtime] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const handleUploadClick = () => {
    document.getElementById("fileInput").click();
  };

  // Unified refs for recording & streaming (must be declared once at top)
  const mediaRecorderRef = React.useRef(null);
  const streamRef = React.useRef(null);
  const recordChunksRef = React.useRef([]);

  // Handle file upload and POST to /predict
  const handleFileChange = async (event) => {
    console.log("handleFileChange fired");
    const file = event.target.files[0];
    if (!file) return;

    setEmotion(null);
    setConfidence(null);

    const formData = new FormData();
    formData.append("file", file, file.name);

    try {
      console.log("Uploading to http://127.0.0.1:8001/predict");
      const response = await fetch("http://127.0.0.1:8001/predict", {
        method: "POST",
        body: formData,
      });

      console.log("Fetch status:", response.status);

      if (!response.ok) {
        const text = await response.text();
        console.error(`Backend error: ${response.status} ${text}`);
        throw new Error(`Backend error: ${response.status} ${text}`);
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        const raw = await response.text();
        console.error("JSON parse error, raw response:", raw);
        throw err;
      }
      console.log("Response JSON from backend:", data);

      if (data.emotion) {
        setEmotion(data.emotion);
        setConfidence(data.confidence);
      } else {
        setEmotion(null);
        setConfidence(null);
      }
    } catch (err) {
      setEmotion(null);
      setConfidence(null);
      console.error("Upload error:", err);
    } finally {
      event.target.value = ""; // allows re-uploading same file
    }
  };

  // ==== Realtime streaming and WebSocket logic (chunked, interval pattern) ====
  const wsRef = React.useRef(null);
  const intervalIdRef = React.useRef(null);
  const chunksRef = React.useRef([]);

  useEffect(() => {
    if (!isRealtime) {
      // Stop cleanup
      if (intervalIdRef.current) {
        clearTimeout(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      if (mediaRecorderRef.current) {
        try {
          if (mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
          }
        } catch {}
        mediaRecorderRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    setEmotion(null);
    setConfidence(null);

    let stopped = false;

    const connectAndRecord = async () => {
      // Check browser support
      if (!window.MediaRecorder) {
        alert("Your browser does not support MediaRecorder.");
        return;
      }

      try {
        console.log("Opening WebSocket ws://127.0.0.1:8001/ws ...");
        const ws = new window.WebSocket("ws://127.0.0.1:8001/ws");
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("WebSocket connection established.");
        };

        ws.onmessage = (event) => {
          console.log("WebSocket message received:", event.data);
          try {
            const data = JSON.parse(event.data);
            if (data.emotion) {
              setEmotion(data.emotion);
              setConfidence(data.confidence);
            } else if (data.error) {
              // If backend sends error messages
              console.error("Backend WebSocket error:", data.error);
            }
          } catch (err) {
            console.error("Error parsing WebSocket message:", err, event.data);
          }
        };

        ws.onerror = (event) => {
          console.error("WebSocket error event:", event);
        };

        ws.onclose = (event) => {
          console.warn("WebSocket closed:", event);
          if (mediaRecorderRef.current) {
            try {
              if (mediaRecorderRef.current.state !== "inactive") {
                mediaRecorderRef.current.stop();
              }
            } catch {}
            mediaRecorderRef.current = null;
          }
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }
          if (intervalIdRef.current) {
            clearTimeout(intervalIdRef.current);
            intervalIdRef.current = null;
          }
        };

        // On ws open, start recording loop
        ws.onopen = async () => {
          // getUserMedia
          const mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          streamRef.current = mediaStream;

          let mimeType = "audio/webm;codecs=opus";
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = "audio/webm";
            if (!MediaRecorder.isTypeSupported(mimeType)) {
              mimeType = "audio/wav";
            }
          }

          const startRecorderChunk = () => {
            if (!isRealtime || stopped) return;

            const mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
            mediaRecorderRef.current = mediaRecorder;
            chunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
              if (e.data && e.data.size) {
                chunksRef.current.push(e.data);
              }
            };

            mediaRecorder.onstop = async () => {
              if (!isRealtime || stopped) return;
              // Join the chunk(s)
              const blob = new Blob(chunksRef.current, { type: mimeType });
              chunksRef.current = [];

              if (
                (ws.readyState === 1 || ws.readyState === "open") &&
                blob.size > 0
              ) {
                // Send ArrayBuffer for compatibility with backend PyAV
                const buffer = await blob.arrayBuffer();
                ws.send(buffer);
              }
              if (isRealtime && !stopped) {
                // Schedule/start next chunk
                intervalIdRef.current = setTimeout(() => {
                  startRecorderChunk();
                }, 0);
              }
            };

            mediaRecorder.start();
            // Stop after fixed time (e.g., ~1s or ~2s)
            intervalIdRef.current = setTimeout(() => {
              try {
                if (mediaRecorder && mediaRecorder.state !== "inactive")
                  mediaRecorder.stop();
              } catch {}
            }, 1350); // 1350ms chunks, adjust for best backend performance
          };

          startRecorderChunk();
        };
      } catch (err) {
        setEmotion(null);
        setConfidence(null);
      }
    };

    connectAndRecord();

    return () => {
      stopped = true;
      if (intervalIdRef.current) {
        clearTimeout(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      if (mediaRecorderRef.current) {
        try {
          if (mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
          }
        } catch {}
        mediaRecorderRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [isRealtime]);

  const handleRealtimeToggle = () => {
    setIsRealtime((prevState) => !prevState);
  };

  // --- Record Button Handler (3s limit) ---
  const handleRecordToggle = async () => {
    if (!isRecording) {
      setIsRecording(true);
      recordChunksRef.current = [];
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        streamRef.current = stream;
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordChunksRef.current.push(e.data);
          }
        };

        mediaRecorder.onstop = async () => {
          const blob = new Blob(recordChunksRef.current, { type: "audio/wav" });
          // Construct a File object for upload compatibility
          const file = new File([blob], "recorded.wav", { type: "audio/wav" });

          // Send to /predict just like a file upload:
          setEmotion(null);
          setConfidence(null);
          const formData = new FormData();
          formData.append("file", file, file.name);

          try {
            console.log("Uploading recorded file to /predict");
            const response = await fetch("http://127.0.0.1:8001/predict", {
              method: "POST",
              body: formData,
            });
            if (!response.ok) {
              const text = await response.text();
              throw new Error(`Backend error: ${response.status} ${text}`);
            }
            const data = await response.json();
            if (data.emotion) {
              setEmotion(data.emotion);
              setConfidence(data.confidence);
            } else {
              setEmotion(null);
              setConfidence(null);
            }
          } catch (err) {
            setEmotion(null);
            setConfidence(null);
            console.error("Upload error:", err);
          }
        };

        mediaRecorder.start();
        console.log("Recording started");
        // Limit to 3 seconds
        setTimeout(() => {
          if (mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
            console.log("Recording stopped (3s limit)");
          }
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }
          setIsRecording(false);
        }, 3000);
      } catch (err) {
        setIsRecording(false);
        console.error("Could not start recording:", err);
      }
    } else {
      // Manual stop: this can optionally force stop before timeout
      setIsRecording(false);
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
        console.log("Recording stopped (manual)");
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    }
  };

  // --- Sinewave Dots Animation ---
  const DOT_COUNT = 4;
  const AMPLITUDE = 18;
  const PERIOD = 1400; // ms, full sinewave loop
  const [phase, setPhase] = useState(0);

  // Make MediaRecorder and chunk refs for record handler
  // const recordChunksRef = React.useRef([]);

  useEffect(() => {
    if (isRecording || isRealtime) {
      const interval = setInterval(() => {
        setPhase((prev) => prev + (2 * Math.PI * 16) / PERIOD); // 16ms step
      }, 16);
      return () => clearInterval(interval);
    } else {
      setPhase(0);
    }
  }, [isRecording, isRealtime]);

  // Emotion display state
  const [emotion, setEmotion] = useState(null);
  const [confidence, setConfidence] = useState(null);

  // Map for emotion -> emoji
  const emotionMap = {
    angry: "😡",
    disgust: "🤢",
    fear: "😱",
    happy: "😄",
    neutral: "😐",
    sad: "😢",
    surprise: "😮",
  };

  // Pill content
  let pillLabel = "Awaiting input";
  let pillEmoji = "🎤";
  if (emotion && emotionMap[emotion]) {
    pillLabel = emotion.charAt(0).toUpperCase() + emotion.slice(1);
    pillEmoji = emotionMap[emotion];
  }

  return (
    <div className="App">
      <div className="dot-sinewave-container">
        {[...Array(DOT_COUNT)].map((_, idx) => {
          const step = (2 * Math.PI * idx) / DOT_COUNT;
          let y = 0;
          if (isRecording || isRealtime) {
            y = Math.sin(phase + step) * AMPLITUDE;
          }
          return (
            <div
              key={idx}
              className="dot-sine"
              style={{
                transform: `translateY(${y}px)`,
              }}
            />
          );
        })}
      </div>
      <div className="emotion-pill">
        <span className="emotion-emoji">{pillEmoji}</span>
        <span className="emotion-label">{pillLabel}</span>
        {confidence != null && emotion && (
          <span className="emotion-confidence">{`(${confidence}%)`}</span>
        )}
      </div>
      <div className="button-container">
        <button type="button" id="upload" onClick={handleUploadClick}>
          <FiUpload />
        </button>
        <input
          type="file"
          id="fileInput"
          accept=".wav"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <button
          type="button"
          id="realtime-toggle"
          className={isRealtime ? "active" : ""}
          aria-pressed={isRealtime}
          onClick={handleRealtimeToggle}
          disabled={isRecording}
        >
          {isRealtime ? <FiWifi /> : <FiWifiOff />}
        </button>
        <button
          type="button"
          id="record"
          className={isRecording ? "recording" : ""}
          onClick={handleRecordToggle}
          disabled={isRealtime}
        >
          {isRecording ? <FiSquare /> : <FiMic />}
        </button>
      </div>
    </div>
  );
}

export default App;
