let audioContext = null;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type !== 'PLAY_SIGNAL_AUDIO') {
    return false;
  }

  playSignalAudio(request)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function playSignalAudio({ action, utterance }) {
  audioContext ||= new AudioContext();

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const isBuy = action === 'BUY';
  const frequencies = isBuy ? [520, 720, 920] : [920, 720, 520];
  const startAt = audioContext.currentTime + 0.03;

  frequencies.forEach((frequency, index) => {
    playTone(frequency, startAt + (index * 0.18), 0.15);
  });

  speakSignal(utterance, isBuy);
  await delay(650);
}

function playTone(frequency, startAt, duration) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.45, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function speakSignal(text, isBuy) {
  if (!text || !('speechSynthesis' in globalThis)) {
    return;
  }

  speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(text);
  speech.rate = 0.9;
  speech.pitch = isBuy ? 1.15 : 0.85;
  speech.volume = 1;
  speechSynthesis.speak(speech);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
