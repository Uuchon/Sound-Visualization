// WAVE LAB - 安定化済み 完全版スケッチ (p5 2.3.4 + p5.sound 0.4.1 前提)
// - AnalyserNode.fftSize の監視と自動補正
// - createSafeFFT / ensureFFTReady
// - userStartAudio 互換ラッパーで遅延初期化
// - safeSetFFTInput / safeMasterGainAmp による保護
// - ISO226簡易補正を用いた perceived loudness の適用

class SafeFFT {
  constructor(smoothing = 0.8, fftSize = 2048) {
    const context = typeof getAudioContext === 'function' ? getAudioContext() : null;
    if (!context) throw new Error('Web Audio AudioContext が利用できません');

    this.analyser = context.createAnalyser();

    // Web Audio requires a power of two from 32 through 32768.
    const allowedSizes = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
    const safeSize = allowedSizes.includes(fftSize) ? fftSize : 2048;

    this.analyser.fftSize = safeSize;
    this.analyser.smoothingTimeConstant = constrain(smoothing, 0, 1);

    this._data = new Uint8Array(this.analyser.frequencyBinCount);
    this._sourceNode = null;
  }

  setInput(source) {
    if (this._sourceNode) {
      try {
        this._sourceNode.disconnect(this.analyser);
      } catch (err) {}
      this._sourceNode = null;
    }

    if (!source) return;

    // p5 sound objects expose their Web Audio node as .output; accept a raw
    // AudioNode as well for compatibility with different p5.sound versions.
    const node =
      source.output && typeof source.output.connect === 'function'
        ? source.output
        : source.input && typeof source.input.connect === 'function'
          ? source.input
          : source;

    if (!node || typeof node.connect !== 'function') {
      throw new Error('FFT入力からAudioNodeを取得できませんでした');
    }

    node.connect(this.analyser);
    this._sourceNode = node;
  }

  analyze() {
    this.analyser.getByteFrequencyData(this._data);
    return Array.from(this._data);
  }
}

function createSafeFFT(smoothing = 0.8, desiredBins = 512) {
  // bins are half the Web Audio fftSize; 512 bins -> fftSize 1024.
  const waveLabBinCount = Math.max(16, Math.min(1024, Math.floor(desiredBins)));
  const waveLabPowerOfTwoBins = Math.pow(2, Math.round(Math.log2(waveLabBinCount)));
  return new SafeFFT(smoothing, waveLabPowerOfTwoBins * 2);
}

let fft = null;
let fftBins = 512;

function ensureFFTReady() {
  if (!fft) fft = createSafeFFT(0.8, fftBins);
}

async function ensureUserAudioStarted() {
  if (typeof userStartAudio === 'function') {
    await userStartAudio();
    return;
  }

  if (typeof getAudioContext === 'function') {
    const ac = getAudioContext();
    if (ac && ac.state === 'suspended') await ac.resume();
  }
}

function safeSetFFTInput(source) {
  ensureFFTReady();
  if (!fft) return;
  if (!source) {
    try {
      if (fft._sourceNode) fft._sourceNode.disconnect(fft.analyser);
    } catch (err) {}
    fft._sourceNode = null;
    return;
  }
  fft.setInput(source);
}

function setOutputVolume(value) {
  const volume = constrain(Number(value), 0, 1);
  if (typeof masterVolume === 'function') masterVolume(volume, 0.05);
}

// ================= 1) グローバル状態と解析変数 =================
let audioProcessor;
let frequencyMapper;
let harmonicAnalyzer;

let dominantFreq = 0;
let dominantAmplitude = 0;
let perceivedLoudness = 0;
let circleRadius = 50;
let currentColor = { r: 255, g: 0, b: 0 };
let harmonicRatio = 0.5;
let spectrumData = [];

let spectralCentroid = 0;
let spectralSpread = 0;

let micActive = false;
let noiseActive = false;

let isCalibrating = false;
let calibrationStartTime = 0;
let calibrationDuration = 3000;

let tempCollectedFreqs = [];
let tempCollectedSpectraSum = [];
let calibrationFramesCount = 0;
let noiseProfile = null;

let micButton, noiseButton, testButton, clearNoiseButton;
let masterVolSlider;
let colorHistory = [];

// ================= 2) 等ラウドネス簡易補正（ISO226 風） =================
function getLoudnessPerceived(freq, amp) {
  if (!freq || !amp) return 0;
  const f = constrain(freq, 20, 20000);
  let sensitivity = 0.1;
  if (f < 200) {
    sensitivity = map(f, 20, 200, 0.05, 0.5, true);
  } else if (f < 1000) {
    sensitivity = map(f, 200, 1000, 0.5, 1.0, true);
  } else if (f <= 4000) {
    sensitivity = map(f, 1000, 4000, 1.0, 1.35, true);
  } else if (f <= 10000) {
    sensitivity = map(f, 4000, 10000, 1.35, 0.7, true);
  } else {
    sensitivity = map(f, 10000, 20000, 0.7, 0.1, true);
  }
  const weightedAmp = amp * sensitivity;
  return constrain(weightedAmp, 0, 1.5);
}

// ================= 3) p5 setup/draw/UI =================
function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont('sans-serif');

  ensureFFTReady();

  audioProcessor = new AudioProcessor();
  frequencyMapper = new FrequencyMapper();
  harmonicAnalyzer = new HarmonicAnalyzer();

  initLoudnessCharts();
  createUIButtons();
}

function draw() {
  background(250, 252, 255);

  if (noiseActive) {
    const sweepFreq = map(sin(frameCount * 0.03), -1, 1, frequencyMapper.minFreq, frequencyMapper.maxFreq);
    audioProcessor.setFreq(sweepFreq);
  }

  if (fft && fft.analyser) {
    spectrumData = fft.analyze();
  } else {
    spectrumData = [];
  }

  analyzeFrequencyContent();
  handleCalibration();
  pushColorHistory();

  push();
  translate(width / 2, height / 2 - 40);
  updateCircleProperties();
  drawDynamicCircle();
  pop();

  drawStatusPanel();
  drawSpectrumBar();
  drawFrequencyGraph();
  drawInfoText();
  drawColorHistoryTimeline();

  if (showCharts) drawLoudnessChartsOverlay();
}

// ================= 4) 音声解析（ガード付き） =================
function analyzeFrequencyContent() {
  if (!spectrumData || spectrumData.length === 0) {
    dominantFreq = 0;
    dominantAmplitude = 0;
    spectralCentroid = 0;
    spectralSpread = 0;
    perceivedLoudness = 0;
    harmonicRatio = 0.5;
    currentColor = { r: 230, g: 235, b: 240 };
    return;
  }

  let totalAmp = 0;
  let weightedFreq = 0;
  let maxAmplitude = 0;
  let maxFreqIndex = 0;
  const nyquist = typeof sampleRate === 'function' ? sampleRate() / 2 : 22050;

  for (let i = 1; i < spectrumData.length; i++) {
    const amp = spectrumData[i];
    if (amp > maxAmplitude) {
      maxAmplitude = amp;
      maxFreqIndex = i;
    }
  }

  dominantAmplitude = maxAmplitude / 255;
  dominantFreq = (maxFreqIndex * nyquist) / spectrumData.length;
  perceivedLoudness = getLoudnessPerceived(dominantFreq, dominantAmplitude);

  for (let i = 1; i < spectrumData.length; i++) {
    const amp = spectrumData[i];
    if (amp < 5) continue;
    const freq = (i * nyquist) / spectrumData.length;
    if (freq < 20 || freq > 20000) continue;
    weightedFreq += freq * amp;
    totalAmp += amp;
  }

  spectralCentroid = totalAmp > 0 ? weightedFreq / totalAmp : 0;

  let variance = 0;
  for (let i = 1; i < spectrumData.length; i++) {
    const amp = spectrumData[i];
    if (amp < 5) continue;
    const freq = (i * nyquist) / spectrumData.length;
    if (freq < 20 || freq > 20000) continue;
    variance += amp * Math.pow(freq - spectralCentroid, 2);
  }
  spectralSpread = totalAmp > 0 ? Math.sqrt(variance / totalAmp) : 0;

  harmonicRatio = harmonicAnalyzer.analyzeHarmonics(spectrumData, dominantFreq);
  currentColor = calculateCentroidColor();
}

function calculateCentroidColor() {
  if (dominantAmplitude < 0.02 || spectralCentroid === 0) {
    return { r: 230, g: 235, b: 240 };
  }

  let nm = frequencyMapper.frequencyToNanometers(spectralCentroid);
  let hueValue = map(nm, 780, 380, 0, 270, true);
  let spreadLog = Math.log(spectralSpread + 1);
  let sat = map(spreadLog, 0, 9, 100, 20, true);
  let bri = map(perceivedLoudness, 0.02, 1.0, 30, 100, true);

  colorMode(HSB, 360, 100, 100);
  let c = color(hueValue, sat, bri);
  let result = { r: red(c), g: green(c), b: blue(c) };
  colorMode(RGB, 255);

  return result;
}

// ================= 5) キャリブレーション =================
function startCalibration() {
  if (!micActive && !noiseActive) {
    alert('マイクを開始するか、テスト音を起動してからテストしてください！');
    return;
  }

  isCalibrating = true;
  calibrationStartTime = millis();
  tempCollectedFreqs = [];
  tempCollectedSpectraSum = [];
  calibrationFramesCount = 0;
}

function handleCalibration() {
  if (!isCalibrating) return;

  let elapsed = millis() - calibrationStartTime;
  let progress = Math.min(100, Math.floor((elapsed / calibrationDuration) * 100));

  if (testButton) {
    testButton.html(`⏳ 計測中 ${progress}%`);
    testButton.style('background-color', '#ff9f43');
  }

  if (elapsed < calibrationDuration) {
    if (spectrumData && spectrumData.length > 0 && dominantAmplitude > 0.01) {
      if (tempCollectedSpectraSum.length !== spectrumData.length) {
        tempCollectedSpectraSum = new Array(spectrumData.length).fill(0);
      }
      for (let i = 0; i < spectrumData.length; i++) {
        tempCollectedSpectraSum[i] += spectrumData[i];
      }
      calibrationFramesCount++;
      if (spectralCentroid > 0) tempCollectedFreqs.push(spectralCentroid);
    }
  } else {
    isCalibrating = false;

    if (testButton) {
      testButton.html('⏱️ 3秒環境テスト');
      testButton.style('background-color', '#10ac84');
    }

    if (calibrationFramesCount > 3 && tempCollectedFreqs.length > 5) {
      noiseProfile = tempCollectedSpectraSum.map(v => v / calibrationFramesCount);
      noiseProfile = smoothArray(noiseProfile, 3);

      let detectedMin = Math.min(...tempCollectedFreqs);
      let detectedMax = Math.max(...tempCollectedFreqs);

      if (detectedMax - detectedMin < 200) {
        detectedMin = Math.max(20, detectedMin - 100);
        detectedMax = Math.min(20000, detectedMax + 100);
      }

      frequencyMapper.updateRange(detectedMin, detectedMax);
    } else {
      alert('十分な音量が検知できませんでした。声を出しながらもう一度お試しください。');
    }
  }
}

function smoothArray(arr, windowSize) {
  const out = new Array(arr.length);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) {
        sum += arr[j];
        cnt++;
      }
    }
    out[i] = cnt > 0 ? sum / cnt : arr[i];
  }
  return out;
}

// ================= 6) UI / 描画ヘルパー =================
function pushColorHistory() {
  colorHistory.push(currentColor);
  if (colorHistory.length > width) colorHistory.shift();
}

function drawColorHistoryTimeline() {
  const timelineHeight = 40;
  const timelineY = height - timelineHeight;
  noStroke();

  for (let i = 0; i < colorHistory.length; i++) {
    const x = map(i, 0, colorHistory.length, 0, width);
    const w = width / colorHistory.length + 1;
    const col = colorHistory[i];
    fill(col.r, col.g, col.b);
    rect(x, timelineY, w, timelineHeight);
  }

  stroke(200);
  strokeWeight(1);
  line(0, timelineY, width, timelineY);

  fill(100);
  noStroke();
  textSize(11);
  textAlign(LEFT, BOTTOM);
  text('⏱️ 音色の時系列ヒストリー（右端が現在）', 20, timelineY - 6);
}

function updateCircleProperties() {
  const targetRadius = 60 + perceivedLoudness * 250;
  circleRadius = lerp(circleRadius, targetRadius, 0.15);
}

function drawDynamicCircle() {
  const segments = 128;
  const baseRadius = circleRadius;
  const deformation = (1 - harmonicRatio) * 0.4;

  noStroke();
  fill(currentColor.r, currentColor.g, currentColor.b, 220);
  beginShape();
  for (let i = 0; i < segments; i++) {
    const angle = TWO_PI * i / segments;
    const noiseAmount = deformation * sin(angle * 5 + frameCount * 0.05) * baseRadius * perceivedLoudness;
    const r = baseRadius + noiseAmount;
    vertex(r * cos(angle), r * sin(angle));
  }
  endShape(CLOSE);

  stroke(currentColor.r, currentColor.g, currentColor.b);
  strokeWeight(3);
  noFill();
  beginShape();
  for (let i = 0; i < segments; i++) {
    const angle = TWO_PI * i / segments;
    const noiseAmount = deformation * sin(angle * 5 + frameCount * 0.05) * baseRadius * perceivedLoudness;
    const r = baseRadius + noiseAmount;
    vertex(r * cos(angle), r * sin(angle));
  }
  endShape(CLOSE);
}

function drawStatusPanel() {
  fill(40);
  noStroke();
  textSize(13);
  textAlign(LEFT, TOP);

  let statusText = '待機中';
  if (isCalibrating) statusText = '⚠️ 3秒間音域計測中...';
  else if (micActive) statusText = 'マイク入力中';
  else if (noiseActive) statusText = 'スイープテスト音生成中';

  const nmValue = frequencyMapper.frequencyToNanometers(spectralCentroid);

  text(`状態: ${statusText}`, 20, 80);
  text(`主要周波数: ${dominantFreq.toFixed(0)} Hz`, 20, 105);
  text(`スペクトル重心: ${spectralCentroid.toFixed(0)} Hz`, 20, 130);
  text(`耳の感度補正音量: ${(perceivedLoudness * 100).toFixed(0)} %`, 20, 155);
  text(`推定波長: ${spectralCentroid > 0 ? nmValue.toFixed(0) : '0'} nm`, 20, 180);

  fill(10, 120, 200);
  text(`適合音域: ${frequencyMapper.minFreq.toFixed(0)} Hz 〜 ${frequencyMapper.maxFreq.toFixed(0)} Hz`, 20, 205);

  fill(80);
  noStroke();
  textSize(12);
  textAlign(LEFT, TOP);
  text(`ノイズ除去: ${noiseProfile ? 'ON' : 'OFF'}`, 20, 230);
}

function drawSpectrumBar() {
  const barX = 20;
  const barY = height - 110;
  const barWidth = min(width - 40, 700);
  const barHeight = 25;

  colorMode(HSB, 360, 100, 100);
  for (let i = 0; i < barWidth; i++) {
    const hueVal = map(i, 0, barWidth, 0, 270);
    stroke(hueVal, 90, 90);
    line(barX + i, barY, barX + i, barY + barHeight);
  }

  colorMode(RGB, 255);
  noFill();
  stroke(180);
  rect(barX, barY, barWidth, barHeight, 4);

  if (spectralCentroid > 0 && dominantAmplitude > 0.02) {
    const currentNm = frequencyMapper.frequencyToNanometers(spectralCentroid);
    const markerX = map(currentNm, 780, 380, barX, barX + barWidth);
    fill(30);
    noStroke();
    triangle(markerX, barY - 2, markerX - 6, barY - 10, markerX + 6, barY - 10);
  }

  fill(80);
  noStroke();
  textSize(11);
  textAlign(LEFT, TOP);
  text(`低音 赤 (${frequencyMapper.minFreq.toFixed(0)}Hz)`, barX, barY + barHeight + 5);
  textAlign(RIGHT, TOP);
  text(`高音 紫 (${frequencyMapper.maxFreq.toFixed(0)}Hz)`, barX + barWidth, barY + barHeight + 5);
}

function drawFrequencyGraph() {
  const panelWidth = 280;
  const panelHeight = 120;
  const panelX = width - panelWidth - 20;
  const panelY = height - panelHeight - 110;

  fill(245, 247, 250, 220);
  stroke(220);
  strokeWeight(1);
  rect(panelX, panelY, panelWidth, panelHeight, 8);

  noFill();
  stroke(currentColor.r, currentColor.g, currentColor.b);
  strokeWeight(2);

  beginShape();
  for (let i = 0; i < spectrumData.length; i++) {
    const x = map(i, 0, spectrumData.length, panelX + 10, panelX + panelWidth - 10);
    const y = map(spectrumData[i], 0, 255, panelY + panelHeight - 10, panelY + 10);
    vertex(x, y);
  }
  endShape();

  fill(100);
  noStroke();
  textSize(11);
  textAlign(LEFT, TOP);
  text('リアルタイムFFTスペクトル', panelX + 10, panelY + 8);
}

function drawInfoText() {
  const panelX = width - 240;
  const panelY = 20;

  fill(40);
  noStroke();
  textSize(14);
  textAlign(LEFT, TOP);
  text('リアルタイム音声・音色可視化', panelX, panelY);

  fill(100);
  textSize(11);
  text(
    '1. 「🎤マイク開始」を押す\n2. 低い音〜高い音を出しながら\n   「⏱️3秒環境テスト」を押す\n3. 周囲の環境に合わせて\n   赤〜紫の色変化が最適化されます\n※ISO 226聴覚感度補正適用済',
    panelX,
    panelY + 25
  );
}

// ================= 7) UI 作成とコールバック =================
function createUIButtons() {
  micButton = createButton('🎤 マイク開始');
  micButton.position(20, 20);
  styleButton(micButton, '#4a69bd');
  micButton.mousePressed(async () => {
    try {
      await ensureUserAudioStarted();
      if (!micActive) {
        if (noiseActive) toggleNoise();
        await audioProcessor.startMicrophone();
        micActive = true;
        micButton.html('🎤 マイク停止');
      } else {
        audioProcessor.stopMicrophone();
        micActive = false;
        micButton.html('🎤 マイク開始');
      }
    } catch (err) {
      console.error('Microphone start failed:', err);
      micActive = false;
      micButton.html('🎤 マイク開始');
      alert('マイクを開始できませんでした。ブラウザのマイク許可とHTTPS/localhostでの実行を確認してください。\n' + (err && err.message ? err.message : err));
    }
  });

  noiseButton = createButton('🔊 スイープ音テスト');
  noiseButton.position(170, 20);
  styleButton(noiseButton, '#4a69bd');
  noiseButton.mousePressed(async () => {
    await ensureUserAudioStarted();
    toggleNoise();
  });

  testButton = createButton('⏱️ 3秒環境テスト');
  testButton.position(320, 20);
  styleButton(testButton, '#10ac84');
  testButton.mousePressed(startCalibration);

  clearNoiseButton = createButton('🧹 ノイズプロファイル削除');
  clearNoiseButton.position(520, 20);
  styleButton(clearNoiseButton, '#778ca3');
  clearNoiseButton.mousePressed(() => {
    noiseProfile = null;
    alert('ノイズプロファイルを削除しました。必要なら再度3秒環境テストを行ってください。');
  });

  createDiv('Master Volume:').position(700, 6);
  masterVolSlider = createSlider(0, 1, 0.6, 0.01);
  masterVolSlider.position(790, 6);
  masterVolSlider.input(() => setOutputVolume(masterVolSlider.value()));
}

function toggleNoise() {
  if (!noiseActive) {
    if (micActive) {
      audioProcessor.stopMicrophone();
      micActive = false;
      micButton.html('🎤 マイク開始');
    }

    audioProcessor.startOscillator();
    noiseActive = true;
    noiseButton.html('🔊 テスト音停止');
  } else {
    audioProcessor.stopOscillator();
    noiseActive = false;
    noiseButton.html('🔊 スイープ音テスト');
  }
}

function styleButton(btn, bgColor) {
  btn.style('background-color', bgColor);
  btn.style('color', 'white');
  btn.style('border', 'none');
  btn.style('padding', '8px 12px');
  btn.style('border-radius', '20px');
  btn.style('cursor', 'pointer');
  btn.style('font-weight', 'bold');
  btn.style('font-size', '12px');
  btn.style('width', '150px');
  btn.style('box-shadow', '0 2px 5px rgba(0,0,0,0.1)');
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ================= 8) 音声マッピングクラス =================
class FrequencyMapper {
  constructor() {
    this.minFreq = 20;
    this.maxFreq = 20000;
  }

  updateRange(minF, maxF) {
    this.minFreq = Math.max(20, Math.min(minF, maxF));
    this.maxFreq = Math.min(20000, Math.max(minF, maxF));
    if (this.maxFreq <= this.minFreq) this.maxFreq = Math.min(20000, this.minFreq + 1);
  }

  frequencyToNanometers(freq) {
    const logMin = Math.log10(this.minFreq);
    const logMax = Math.log10(this.maxFreq);
    const logFreq = Math.log10(constrain(freq, this.minFreq, this.maxFreq));
    return 780 - (780 - 380) * ((logFreq - logMin) / (logMax - logMin));
  }
}

class HarmonicAnalyzer {
  analyzeHarmonics(spectrum, fundamentalFreq) {
    if (fundamentalFreq < 20 || fundamentalFreq > 20000) return 0.5;

    let harmonicStrength = 0;
    let totalStrength = 0;
    const nyquist = typeof sampleRate === 'function' ? sampleRate() / 2 : 22050;

    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      const harmonicFreq = fundamentalFreq * harmonic;
      if (harmonicFreq > 20000) break;

      const index = Math.round((harmonicFreq / nyquist) * spectrum.length);
      if (index >= 0 && index < spectrum.length) {
        totalStrength += spectrum[index];
        harmonicStrength += spectrum[index] * (1 - (harmonic - 1) * 0.1);
      }
    }

    return totalStrength > 0 ? constrain(harmonicStrength / totalStrength, 0.1, 1.0) : 0.5;
  }
}

// === AudioProcessor: getUserMedia capture and direct Web Audio FFT routing ===
class AudioProcessor {
  constructor() {
    this.micStream = null;
    this.micSource = null;
    this.micStarted = false;
    this.osc = new p5.Oscillator('sine');
    this.osc.amp(0.2);
    this.oscStarted = false;
  }

  async startMicrophone() {
    await ensureUserAudioStarted();

    if (this.micStarted && this.micStream) {
      safeSetFFTInput(this.micSource);
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('このブラウザまたは実行環境ではマイク取得APIが使えません。HTTPSまたはlocalhostで開いてください。');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    try {
      const context = getAudioContext();
      if (context.state === 'suspended') await context.resume();

      const source = context.createMediaStreamSource(stream);
      safeSetFFTInput(source);

      this.micStream = stream;
      this.micSource = source;
      this.micStarted = true;

      console.log('Microphone stream started and connected to FFT.');
    } catch (err) {
      stream.getTracks().forEach(track => track.stop());
      throw err;
    }
  }

  stopMicrophone() {
    try {
      if (this.micSource) this.micSource.disconnect();
      if (this.micStream) this.micStream.getTracks().forEach(track => track.stop());
    } catch (err) {
      console.warn('Microphone stop error:', err);
    }

    this.micSource = null;
    this.micStream = null;
    this.micStarted = false;
    micActive = false;

    // Release the analyser's reference to the stopped microphone source.
    safeSetFFTInput(null);
  }

  startOscillator() {
    try {
      if (!this.oscStarted) {
        this.osc.start();
        this.oscStarted = true;
      }
      safeSetFFTInput(this.osc);
    } catch (err) {
      console.warn('Oscillator start error:', err);
    }
  }

  stopOscillator() {
    try {
      if (this.oscStarted) this.osc.stop();
    } catch (err) {
      console.warn('Oscillator stop error:', err);
    }

    this.oscStarted = false;
    safeSetFFTInput(null);
  }

  setFreq(freq) {
    try {
      this.osc.freq(freq);
    } catch (err) {
      console.warn('setFreq error:', err);
    }
  }
}

// ============================================================
// loudness_charts.js  - WAVE LAB 追加モジュール
//  1) ISO 226:2003 の正式パラメータによる等ラウドネス曲線
//  2) 「周波数 → 色相 / 音量(phon) → 明度 / 広がり → 彩度」の対応グラフ
//  3) 実時間の getLoudnessPerceived() を ISO226 ベースに統一
// ============================================================

// ---------- ISO 226:2003 パラメータ（20Hz〜12.5kHz, 29点） ----------
const ISO = {
  f: [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500],
  af: [0.532,0.506,0.480,0.455,0.432,0.409,0.387,0.367,0.349,0.330,0.315,0.301,0.288,0.276,0.267,0.259,0.253,0.250,0.246,0.244,0.243,0.243,0.243,0.242,0.242,0.245,0.254,0.271,0.301],
  Lu: [-31.6,-27.2,-23.0,-19.1,-15.9,-13.0,-10.3,-8.1,-6.2,-4.5,-3.1,-2.0,-1.1,-0.4,0.0,0.3,0.5,0.0,-2.7,-4.1,-1.0,1.7,2.5,1.2,-2.1,-7.1,-11.2,-10.7,-3.1],
  Tf: [78.5,68.7,59.5,51.1,44.0,37.5,31.5,26.5,22.1,17.9,14.4,11.4,8.6,6.2,4.4,3.0,2.2,2.4,3.5,1.7,-1.3,-4.2,-6.0,-5.4,-1.5,6.0,12.6,13.9,12.3]
};

const PHON_MAX = 90;
let splOffset = 100; // 簡易校正: 0 dBFS を何 dB SPL とみなすか
let showCharts = false;
let splSlider, chartButton;
let heatCache = null;
let heatKey = '';

// ---------- 等ラウドネス計算 ----------
function isoParam(arr, freq) {
  const f = constrain(freq, ISO.f[0], ISO.f[ISO.f.length - 1]);
  let i = 0;
  while (i < ISO.f.length - 2 && f > ISO.f[i + 1]) i++;
  const t = (Math.log(f) - Math.log(ISO.f[i])) / (Math.log(ISO.f[i + 1]) - Math.log(ISO.f[i]));
  return arr[i] + (arr[i + 1] - arr[i]) * t;
}

// 周波数 freq で phon 値 phon に聞こえる音圧レベル (dB SPL)
function contourSPL(freq, phon) {
  const af = isoParam(ISO.af, freq);
  const Lu = isoParam(ISO.Lu, freq);
  const Tf = isoParam(ISO.Tf, freq);

  let Af = 4.47e-3 * (Math.pow(10, 0.025 * phon) - 1.15) +
           Math.pow(0.4 * Math.pow(10, (Tf + Lu) / 10 - 9), af);

  Af = Math.max(Af, 1e-9);
  return (10 / af) * Math.log10(Af) - Lu + 94;
}

// 逆変換: 周波数 / dB SPL → phon
function phonFromSPL(freq, spl) {
  let lo = 0;
  let hi = 100;

  if (spl <= contourSPL(freq, lo)) return 0;
  if (spl >= contourSPL(freq, hi)) return hi;

  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (contourSPL(freq, mid) < spl) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// 既存コードの置き換え: amp は 0〜1 (FFTバイト値/255), 戻り値は 0〜1
function getLoudnessPerceived(freq, amp) {
  if (!freq || !amp) return 0;

  // FFT 解析の dBFS → SPL 近似
  const dbfs = -100 + amp * 70;
  const spl = dbfs + splOffset;

  return constrain(phonFromSPL(freq, spl) / PHON_MAX, 0, 1);
}

// ---------- 色の対応関数 ----------
function hsbColor(h, s, b, a = 255) {
  colorMode(HSB, 360, 100, 100, 255);
  const c = color(h, s, b, a);
  colorMode(RGB, 255);
  return c;
}

function freqRangeMin() {
  return typeof frequencyMapper !== 'undefined' ? frequencyMapper.minFreq : 20;
}

function freqRangeMax() {
  return typeof frequencyMapper !== 'undefined' ? frequencyMapper.maxFreq : 20000;
}

function hueFromFreq(f) {
  const lo = Math.log10(freqRangeMin());
  const hi = Math.log10(freqRangeMax());
  const t = (Math.log10(constrain(f, freqRangeMin(), freqRangeMax())) - lo) / (hi - lo);
  return t * 270;
}

function nmFromHue(h) {
  return 780 - (780 - 380) * (h / 270);
}

function briFromPhon(phon) {
  return map(phon / PHON_MAX, 0.02, 1.0, 30, 100, true);
}

function satFromSpread(sp) {
  return map(Math.log(sp + 1), 0, 9, 100, 20, true);
}

// ---------- 初期化 ----------
function initLoudnessCharts() {
  chartButton = createButton('📈 音と色のグラフ');
  chartButton.position(700, 34);
  styleButton(chartButton, '#8e44ad');
  chartButton.mousePressed(toggleCharts);

  splSlider = createSlider(60, 120, splOffset, 1);
  splSlider.position(350, 72);
  splSlider.input(() => {
    splOffset = splSlider.value();
  });
  splSlider.hide();
}

function toggleCharts() {
  showCharts = !showCharts;
  chartButton.html(showCharts ? '📈 グラフを閉じる' : '📈 音と色のグラフ');
  if (showCharts) splSlider.show();
  else splSlider.hide();
}

function keyPressed() {
  if (key === 'g' || key === 'G') toggleCharts();
}

// ---------- 描画ユーティリティ ----------
const FMIN = 20;
const FMAX = 20000;

function xOfFreq(f, x, w) {
  return x + w * (Math.log10(constrain(f, FMIN, FMAX)) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN));
}

function fmtHz(f) {
  return f >= 1000 ? (f / 1000) + 'k' : String(f);
}

function liveSPL() {
  return -100 + dominantAmplitude * 70 + splOffset;
}

function liveActive() {
  return dominantAmplitude > 0.02 && spectralCentroid > 0;
}

function drawMarker(px, py, col) {
  stroke(30);
  strokeWeight(2);
  fill(col);
  circle(px, py, 14);
}

// ---------- 1) 等ラウドネス曲線 ----------
function drawContourChart(x, y, w, h) {
  const yLo = 0;
  const yHi = 120;
  const yOf = spl => map(spl, yLo, yHi, y + h, y, true);

  fill(255);
  stroke(220);
  strokeWeight(1);
  rect(x, y, w, h, 8);

  textSize(10);
  fill(120);
  noStroke();

  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const gx = xOfFreq(f, x, w);
    stroke(235);
    line(gx, y, gx, y + h);
    noStroke();
    textAlign(CENTER, TOP);
    text(fmtHz(f), gx, y + h + 3);
  }

  for (let d = 0; d <= 120; d += 20) {
    const gy = yOf(d);
    stroke(235);
    line(x, gy, x + w, gy);
    noStroke();
    textAlign(RIGHT, CENTER);
    text(d, x - 4, gy);
  }

  fill(80);
  textAlign(LEFT, BOTTOM);
  textSize(12);
  text('等ラウドネス曲線 (ISO 226:2003)  横: 周波数[Hz]  縦: 音圧レベル[dB SPL]', x, y - 4);

  for (const ph of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    stroke(lerpColor(color(130, 180, 240), color(20, 30, 110), ph / PHON_MAX));
    strokeWeight(ph % 20 === 0 ? 2.2 : 1.2);
    noFill();

    beginShape();
    for (let i = 0; i <= 120; i++) {
      const f = FMIN * Math.pow(12500 / FMIN, i / 120);
      vertex(xOfFreq(f, x, w), yOf(contourSPL(f, ph)));
    }
    endShape();

    noStroke();
    fill(60);
    textSize(10);
    textAlign(LEFT, CENTER);
    text(ph + ' phon', xOfFreq(12500, x, w) + 3, yOf(contourSPL(12500, ph)));
  }

  if (liveActive()) {
    const px = xOfFreq(dominantFreq, x, w);
    const py = yOf(liveSPL());
    drawMarker(px, py, color(currentColor.r, currentColor.g, currentColor.b));
    noStroke();
    fill(30);
    textSize(11);
    textAlign(LEFT, BOTTOM);

    const ph = phonFromSPL(dominantFreq, liveSPL());
    text(`${dominantFreq.toFixed(0)}Hz / ${liveSPL().toFixed(0)}dB → ${ph.toFixed(0)} phon`,
      constrain(px + 10, x + 4, x + w - 190),
      py - 8
    );
  }
}

// ---------- 2) 周波数 × phon → 色(HSB) のカラーマップ ----------
function getHeatmap(w, h) {
  const key = [w, h, freqRangeMin(), freqRangeMax()].join();
  if (key !== heatKey) {
    if (heatCache) heatCache.remove();

    heatCache = createGraphics(w, h);
    heatCache.pixelDensity(1);
    heatCache.noStroke();
    heatCache.colorMode(HSB, 360, 100, 100);

    const cols = 72;
    const rows = 36;
    const cw = w / cols;
    const ch = h / rows;

    for (let i = 0; i < cols; i++) {
      const f = FMIN * Math.pow(FMAX / FMIN, (i + 0.5) / cols);
      for (let j = 0; j < rows; j++) {
        const ph = PHON_MAX * (1 - (j + 0.5) / rows);
        heatCache.fill(hueFromFreq(f), 85, briFromPhon(ph));
        heatCache.rect(i * cw, j * ch, cw + 1, ch + 1);
      }
    }

    heatKey = key;
  }
  return heatCache;
}

function drawColorMap(x, y, w, h) {
  image(getHeatmap(Math.floor(w), Math.floor(h)), x, y);

  noFill();
  stroke(220);
  strokeWeight(1);
  rect(x, y, w, h, 8);

  textSize(10);
  fill(120);
  noStroke();
  for (const f of [20, 100, 1000, 10000, 20000]) {
    textAlign(CENTER, TOP);
    text(fmtHz(f), xOfFreq(f, x, w), y + h + 3);
  }

  for (let p = 0; p <= PHON_MAX; p += 30) {
    textAlign(RIGHT, CENTER);
    text(p, x - 4, map(p, 0, PHON_MAX, y + h, y));
  }

  fill(80);
  textAlign(LEFT, BOTTOM);
  textSize(12);
  text('色の対応マップ  横: 周波数(→色相)  縦: 感じる大きさ[phon](→明度)', x, y - 4);

  if (liveActive()) {
    const px = xOfFreq(spectralCentroid, x, w);
    const py = map(perceivedLoudness * PHON_MAX, 0, PHON_MAX, y + h, y, true);
    drawMarker(px, py, color(currentColor.r, currentColor.g, currentColor.b));
  }
}

// ---------- 3) HSB 3軸のグラデーションバー ----------
function drawStrip(label, x, y, w, colorAt, leftText, rightText, markerT) {
  const h = 18;

  for (let i = 0; i < w; i += 2) {
    stroke(colorAt(i / w));
    strokeWeight(2.5);
    line(x + i, y, x + i, y + h);
  }

  noFill();
  stroke(190);
  strokeWeight(1);
  rect(x, y, w, h, 4);

  noStroke();
  fill(60);
  textSize(12);
  textAlign(LEFT, BOTTOM);
  text(label, x, y - 3);

  fill(110);
  textSize(10);
  textAlign(LEFT, TOP);
  text(leftText, x, y + h + 3);
  textAlign(RIGHT, TOP);
  text(rightText, x + w, y + h + 3);

  if (markerT !== null && markerT >= 0) {
    const mx = x + w * constrain(markerT, 0, 1);
    fill(30);
    noStroke();
    triangle(mx, y - 1, mx - 5, y - 9, mx + 5, y - 9);
  }
}

function drawHSBStrips(x, y, w) {
  const live = liveActive();
  const curHue = live ? hueFromFreq(spectralCentroid) : 210;
  const curSat = live ? satFromSpread(spectralSpread) : 90;
  const curBri = live ? briFromPhon(perceivedLoudness * PHON_MAX) : 90;
  const lo = Math.log10(freqRangeMin());
  const hi = Math.log10(freqRangeMax());

  drawStrip(
    `H 色相 ← スペクトル重心 ${live ? '(' + curHue.toFixed(0) + '° / ' + nmFromHue(curHue).toFixed(0) + 'nm)' : ''}`,
    x,
    y,
    w,
    t => hsbColor(t * 270, 85, 90),
    `${freqRangeMin().toFixed(0)}Hz 赤 (780nm)`,
    `${freqRangeMax().toFixed(0)}Hz 紫 (380nm)`,
    live ? (Math.log10(constrain(spectralCentroid, freqRangeMin(), freqRangeMax())) - lo) / (hi - lo) : -1
  );

  drawStrip(
    `S 彩度 ← スペクトルの広がり ${live ? '(' + curSat.toFixed(0) + '%)' : ''}`,
    x,
    y + 62,
    w,
    t => hsbColor(curHue, map(t, 0, 1, 100, 20), 90),
    '純音に近い (鮮やか)',
    'ノイズ的 (くすむ)',
    live ? map(Math.log(spectralSpread + 1), 0, 9, 0, 1, true) : -1
  );

  drawStrip(
    `B 明度 ← 感じる大きさ(phon) ${live ? '(' + (perceivedLoudness * PHON_MAX).toFixed(0) + ' phon → ' + curBri.toFixed(0) + '%)' : ''}`,
    x,
    y + 124,
    w,
    t => hsbColor(curHue, 85, briFromPhon(t * PHON_MAX)),
    '0 phon (暗)',
    `${PHON_MAX} phon (明)`,
    live ? perceivedLoudness : -1
  );
}

// ---------- オーバーレイ全体 ----------
function drawLoudnessChartsOverlay() {
  noStroke();
  fill(250, 252, 255, 245);
  rect(0, 70, width, height - 70);

  fill(40);
  textSize(15);
  textAlign(LEFT, TOP);
  text('音を「耳の感度」で補正して色にする仕組み', 20, 74);

  fill(80);
  textSize(11);
  text(`校正: 0 dBFS = ${splOffset} dB SPL`, 20, 104);
  fill(120);
  text('(マイクの実際の感度に合わせてスライダーで調整)', 410, 104);

  const m = 40;
  const top = 150;
  const panelW = (width - m * 3) / 2;
  const panelH = constrain(height - top - 230, 150, 340);

  drawContourChart(m, top, panelW, panelH);
  drawColorMap(m * 2 + panelW, top, panelW, panelH);
  drawHSBStrips(m, top + panelH + 55, width - m * 2);

  fill(120);
  textSize(10);
  textAlign(LEFT, BOTTOM);
  text('G キーでも開閉できます', 20, height - 6);
}
