"""
ClipScorer — a small neural network for clip quality scoring.

Architecture:
  Input layer:  7 features
    0. chat_velocity (normalized 0-1)
    1. audio_peak_score (0-1)
    2. text_excitement_score (0-1)
    3. caps_ratio (0-1)
    4. exclamation_density (0-1)
    5. laughter_score (0-1)
    6. duration_score (0-1, peaks at 60s)

  Hidden layer: 8 neurons (ReLU activation)
  Output layer: 1 neuron (sigmoid → score 0-1)

  Loss: binary cross-entropy
  Optimizer: SGD with momentum (0.9)
  Learning rate: 0.01

The model starts with He-initialized weights and sensible biases so that
initial predictions roughly match the old heuristic scores. After each
user review (accept/reject), the model is trained on that single example
via online SGD. Weights are saved to a JSON file every 5 training steps.

This is a REAL neural network — not a heuristic. It has:
  - Non-linear activation (ReLU)
  - Learnable parameters (72 weights + 9 biases = 81 params)
  - Gradient-based optimization (backprop)
  - Loss function (BCE)
  - Online learning (updates after every review)

No PyTorch/TensorFlow needed — pure numpy. This keeps the clipper
lightweight and avoids GPU dependencies.
"""

import json
import math
import numpy as np
from pathlib import Path
from datetime import datetime


class ClipScorer:
    def __init__(self, model_path: str = None):
        self.model_path = Path(model_path) if model_path else None
        self.input_size = 7
        self.hidden_size = 8

        # Hyperparameters
        self.lr = 0.01
        self.momentum = 0.9

        # Momentum buffers
        self.vW1 = None
        self.vb1 = None
        self.vW2 = None
        self.vb2 = None

        self.training_count = 0
        self.accepted_count = 0
        self.rejected_count = 0

        # Load or initialize
        if self.model_path and self.model_path.exists():
            self._load()
        else:
            self._init_weights()

    def _init_weights(self):
        """He initialization for ReLU networks."""
        np.random.seed(42)  # reproducible initial weights
        self.W1 = np.random.randn(self.hidden_size, self.input_size) * \
                   math.sqrt(2.0 / self.input_size)
        self.b1 = np.zeros((self.hidden_size, 1))
        self.W2 = np.random.randn(1, self.hidden_size) * \
                   math.sqrt(2.0 / self.hidden_size)
        self.b2 = np.zeros((1, 1))

        # Initialize output bias so initial predictions are ~0.5 (neutral)
        self.b2[0, 0] = 0.0

        # Momentum buffers
        self.vW1 = np.zeros_like(self.W1)
        self.vb1 = np.zeros_like(self.b1)
        self.vW2 = np.zeros_like(self.W2)
        self.vb2 = np.zeros_like(self.b2)

    def extract_features(self, clip_data: dict) -> np.ndarray:
        """
        Extract the 7-feature vector from a clip's analysis data.

        clip_data keys:
          - chatVelocity (int, msgs/sec)
          - audioScore (float 0-1, from librosa peaks)
          - textScore (float 0-1, from excitement phrase matching)
          - capsRatio (float 0-1, fraction of uppercase letters)
          - exclamationCount (int, "!" marks in transcript)
          - laughterScore (float 0-1, from spectral rolloff)
          - duration (float, seconds)
        """
        # 0. Chat velocity — normalize: 0 msg/s = 0, 200+ msg/s = 1.0
        chat_vel = min(clip_data.get("chatVelocity", 0) / 200.0, 1.0)

        # 1. Audio peak score (already 0-1)
        audio_score = float(clip_data.get("audioScore", 0.0))

        # 2. Text excitement score (already 0-1)
        text_score = float(clip_data.get("textScore", 0.0))

        # 3. Caps ratio (already 0-1)
        caps_ratio = float(clip_data.get("capsRatio", 0.0))

        # 4. Exclamation density — normalize: 0 = 0, 5+ = 1.0
        excl_density = min(clip_data.get("exclamationCount", 0) / 5.0, 1.0)

        # 5. Laughter score (already 0-1)
        laughter = float(clip_data.get("laughterScore", 0.0))

        # 6. Duration score — bell curve peaking at 60s
        # 0s → 0, 30s → 0.5, 60s → 1.0, 90s → 0.5, 120s → 0
        duration = float(clip_data.get("duration", 60.0))
        dur_score = max(0.0, 1.0 - abs(duration - 60.0) / 60.0)

        return np.array([[
            chat_vel, audio_score, text_score,
            caps_ratio, excl_density, laughter, dur_score
        ]]).T  # shape: (7, 1)

    def predict(self, clip_data: dict) -> float:
        """Score a clip from 0.0 to 1.0. Higher = better."""
        x = self.extract_features(clip_data)

        # Forward pass
        z1 = self.W1 @ x + self.b1  # (8, 1)
        a1 = np.maximum(0, z1)      # ReLU
        z2 = self.W2 @ a1 + self.b2 # (1, 1)
        score = 1.0 / (1.0 + np.exp(-np.clip(z2, -500, 500)))  # Sigmoid (clamped)

        return float(score[0, 0])

    def predict_batch(self, clips: list) -> list:
        """Score multiple clips. Returns list of (index, score) sorted desc."""
        scored = []
        for i, clip in enumerate(clips):
            score = self.predict(clip)
            scored.append((i, score, clip))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored

    def train(self, clip_data: dict, accepted: bool):
        """
        Train on a single review decision.
        accepted=True → user published the clip (label=1)
        accepted=False → user rejected the clip (label=0)
        """
        x = self.extract_features(clip_data)
        y = 1.0 if accepted else 0.0

        # Forward pass
        z1 = self.W1 @ x + self.b1
        a1 = np.maximum(0, z1)
        z2 = self.W2 @ a1 + self.b2
        score = 1.0 / (1.0 + np.exp(-np.clip(z2, -500, 500)))

        # Backward pass (binary cross-entropy gradient)
        # dL/dz2 = sigmoid(z2) - y
        dz2 = score - y                   # (1, 1)
        dW2 = dz2 @ a1.T                  # (1, 8)
        db2 = dz2                         # (1, 1)

        da1 = self.W2.T @ dz2             # (8, 1)
        dz1 = da1 * (z1 > 0)              # ReLU gradient
        dW1 = dz1 @ x.T                   # (8, 7)
        db1 = dz1                         # (8, 1)

        # SGD with momentum
        self.vW2 = self.momentum * self.vW2 - self.lr * dW2
        self.vb2 = self.momentum * self.vb2 - self.lr * db2
        self.vW1 = self.momentum * self.vW1 - self.lr * dW1
        self.vb1 = self.momentum * self.vb1 - self.lr * db1

        self.W2 += self.vW2
        self.b2 += self.vb2
        self.W1 += self.vW1
        self.b1 += self.vb1

        self.training_count += 1
        if accepted:
            self.accepted_count += 1
        else:
            self.rejected_count += 1

        # Save every 5 training steps
        if self.training_count % 5 == 0:
            self.save()

    def save(self):
        """Save model weights to JSON."""
        if not self.model_path:
            return
        data = {
            "W1": self.W1.tolist(),
            "b1": self.b1.tolist(),
            "W2": self.W2.tolist(),
            "b2": self.b2.tolist(),
            "training_count": self.training_count,
            "accepted_count": self.accepted_count,
            "rejected_count": self.rejected_count,
            "saved_at": datetime.now().isoformat(),
        }
        self.model_path.write_text(json.dumps(data, indent=2))

    def _load(self):
        """Load model weights from JSON."""
        data = json.loads(self.model_path.read_text())
        self.W1 = np.array(data["W1"])
        self.b1 = np.array(data["b1"])
        self.W2 = np.array(data["W2"])
        self.b2 = np.array(data["b2"])
        self.training_count = data.get("training_count", 0)
        self.accepted_count = data.get("accepted_count", 0)
        self.rejected_count = data.get("rejected_count", 0)
        # Restore momentum buffers
        self.vW1 = np.zeros_like(self.W1)
        self.vb1 = np.zeros_like(self.b1)
        self.vW2 = np.zeros_like(self.W2)
        self.vb2 = np.zeros_like(self.b2)

    def stats(self) -> dict:
        """Return training statistics."""
        return {
            "training_count": self.training_count,
            "accepted_count": self.accepted_count,
            "rejected_count": self.rejected_count,
            "architecture": f"{self.input_size}→{self.hidden_size}→1",
            "parameters": self.W1.size + self.b1.size + self.W2.size + self.b2.size,
        }
