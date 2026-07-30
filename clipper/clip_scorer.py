"""
ClipScorer v2 — 3-class neural network with YouTube retention feedback.

Architecture:
  Input layer:  12 features
    0.  chat_velocity (normalized 0-1)
    1.  audio_peak_score (0-1)
    2.  text_excitement_score (0-1)
    3.  caps_ratio (0-1)
    4.  exclamation_density (0-1)
    5.  laughter_score (0-1)
    6.  duration_score (0-1, peaks at 60s)
    7.  motion_score (0-1, frame difference energy)
    8.  scene_count (0-1, normalized: 0 scenes = 0, 10+ = 1)
    9.  clap_score (0-1, audio-text similarity)
    10. llm_viral_score (0-1, from LLM)
    11. opening_retention (0-1, from YouTube analytics — 0 if not published yet)

  Hidden layer: 16 neurons (ReLU)
  Output layer: 3 neurons (softmax)
    0: accept (publish)
    1: reject_bad (low quality)
    2: not_interested (duplicate, already clipped, etc.)

  Loss: categorical cross-entropy
  Optimizer: SGD with momentum (0.9)
  Learning rate: 0.01

The opening_retention feature is the KEY innovation — it creates a feedback
loop from YouTube analytics back into clip selection. If a clip with a
certain feature pattern consistently has low opening retention (viewers
click away in the first 10 seconds), the model learns to avoid that pattern
and trim more aggressively.
"""

import json
import math
import numpy as np
from pathlib import Path
from datetime import datetime


class ClipScorer:
    def __init__(self, model_path: str = None):
        self.model_path = Path(model_path) if model_path else None
        self.input_size = 12
        self.hidden_size = 16
        self.output_size = 3  # accept, reject_bad, not_interested

        self.lr = 0.01
        self.momentum = 0.9

        self.vW1 = None
        self.vb1 = None
        self.vW2 = None
        self.vb2 = None

        self.training_count = 0
        self.class_counts = [0, 0, 0]  # accept, reject_bad, not_interested

        if self.model_path and self.model_path.exists():
            self._load()
        else:
            self._init_weights()

    def _init_weights(self):
        np.random.seed(42)
        self.W1 = np.random.randn(self.hidden_size, self.input_size) * \
                   math.sqrt(2.0 / self.input_size)
        self.b1 = np.zeros((self.hidden_size, 1))
        self.W2 = np.random.randn(self.output_size, self.hidden_size) * \
                   math.sqrt(2.0 / self.hidden_size)
        self.b2 = np.zeros((self.output_size, 1))

        self.vW1 = np.zeros_like(self.W1)
        self.vb1 = np.zeros_like(self.b1)
        self.vW2 = np.zeros_like(self.W2)
        self.vb2 = np.zeros_like(self.b2)

    def extract_features(self, clip_data: dict) -> np.ndarray:
        """Extract the 12-feature vector from a clip's analysis data."""
        chat_vel = min(clip_data.get("chatVelocity", 0) / 200.0, 1.0)
        audio_score = float(clip_data.get("audioScore", 0.0))
        text_score = float(clip_data.get("textScore", 0.0))
        caps_ratio = float(clip_data.get("capsRatio", 0.0))
        excl_density = min(clip_data.get("exclamationCount", 0) / 5.0, 1.0)
        laughter = float(clip_data.get("laughterScore", 0.0))

        duration = float(clip_data.get("duration", 60.0))
        dur_score = max(0.0, 1.0 - abs(duration - 60.0) / 60.0)

        # New features (v2)
        motion_score = float(clip_data.get("motionScore", 0.0))
        scene_count = min(float(clip_data.get("sceneCount", 0)) / 10.0, 1.0)
        clap_score = float(clip_data.get("clapScore", 0.0))
        llm_score = float(clip_data.get("llmViralScore", 0.0))
        opening_retention = float(clip_data.get("openingRetention", 0.0))

        return np.array([[
            chat_vel, audio_score, text_score,
            caps_ratio, excl_density, laughter, dur_score,
            motion_score, scene_count, clap_score,
            llm_score, opening_retention
        ]]).T  # shape: (12, 1)

    def predict_proba(self, clip_data: dict) -> np.ndarray:
        """Return probability distribution over 3 classes."""
        x = self.extract_features(clip_data)

        z1 = self.W1 @ x + self.b1
        a1 = np.maximum(0, z1)
        z2 = self.W2 @ a1 + self.b2

        # Softmax
        z2_max = np.max(z2)
        exp_z = np.exp(z2 - z2_max)
        probs = exp_z / np.sum(exp_z)

        return probs

    def predict(self, clip_data: dict) -> float:
        """
        Return acceptance probability (0.0 to 1.0).
        This is P(accept) — used for ranking clips.
        """
        probs = self.predict_proba(clip_data)
        return float(probs[0, 0])

    def predict_class(self, clip_data: dict) -> int:
        """Return predicted class: 0=accept, 1=reject_bad, 2=not_interested."""
        probs = self.predict_proba(clip_data)
        return int(np.argmax(probs))

    def predict_batch(self, clips: list) -> list:
        """Score multiple clips. Returns list of (index, score, clip) sorted desc."""
        scored = []
        for i, clip in enumerate(clips):
            score = self.predict(clip)
            scored.append((i, score, clip))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored

    def train(self, clip_data: dict, label: int):
        """
        Train on a single review decision.
        label: 0=accept, 1=reject_bad, 2=not_interested
        """
        x = self.extract_features(clip_data)

        # Forward pass
        z1 = self.W1 @ x + self.b1
        a1 = np.maximum(0, z1)
        z2 = self.W2 @ a1 + self.b2

        z2_max = np.max(z2)
        exp_z = np.exp(z2 - z2_max)
        probs = exp_z / np.sum(exp_z)

        # Backward pass (categorical cross-entropy gradient)
        y = np.zeros((self.output_size, 1))
        y[label, 0] = 1.0

        dz2 = probs - y                    # (3, 1)
        dW2 = dz2 @ a1.T                   # (3, 16)
        db2 = dz2                          # (3, 1)

        da1 = self.W2.T @ dz2              # (16, 1)
        dz1 = da1 * (z1 > 0)               # ReLU gradient
        dW1 = dz1 @ x.T                    # (16, 12)
        db1 = dz1                          # (16, 1)

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
        self.class_counts[label] += 1

        if self.training_count % 5 == 0:
            self.save()

    def train_with_retention(self, clip_data: dict, retention_score: float):
        """
        Train using YouTube retention data.

        retention_score: 0-1 (average view percentage)
          - >0.5 → viewers stayed → positive signal → train as 'accept'
          - <0.3 → viewers left → negative signal → train as 'reject_bad'
          - 0.3-0.5 → neutral, don't train

        This creates the feedback loop from YouTube analytics back into
        clip selection. The model learns which feature patterns lead to
        high-retention clips and prioritizes them.
        """
        if retention_score > 0.5:
            self.train(clip_data, 0)  # accept
        elif retention_score < 0.3:
            self.train(clip_data, 1)  # reject_bad
        # else: neutral, skip

    def save(self):
        if not self.model_path:
            return
        data = {
            "W1": self.W1.tolist(),
            "b1": self.b1.tolist(),
            "W2": self.W2.tolist(),
            "b2": self.b2.tolist(),
            "training_count": self.training_count,
            "class_counts": self.class_counts,
            "saved_at": datetime.now().isoformat(),
        }
        self.model_path.write_text(json.dumps(data, indent=2))

    def _load(self):
        data = json.loads(self.model_path.read_text())
        self.W1 = np.array(data["W1"])
        self.b1 = np.array(data["b1"])
        self.W2 = np.array(data["W2"])
        self.b2 = np.array(data["b2"])
        self.training_count = data.get("training_count", 0)
        self.class_counts = data.get("class_counts", [0, 0, 0])
        self.vW1 = np.zeros_like(self.W1)
        self.vb1 = np.zeros_like(self.b1)
        self.vW2 = np.zeros_like(self.W2)
        self.vb2 = np.zeros_like(self.b2)

    def stats(self) -> dict:
        return {
            "training_count": self.training_count,
            "class_counts": {
                "accept": self.class_counts[0],
                "reject_bad": self.class_counts[1],
                "not_interested": self.class_counts[2],
            },
            "architecture": f"{self.input_size}→{self.hidden_size}→{self.output_size}",
            "parameters": self.W1.size + self.b1.size + self.W2.size + self.b2.size,
        }
