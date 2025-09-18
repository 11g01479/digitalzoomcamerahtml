/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// DOM Elements
const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const photo = document.getElementById('photo') as HTMLImageElement;
const recordedVideo = document.getElementById('recorded-video') as HTMLVideoElement;
const captureButton = document.getElementById('capture-button') as HTMLButtonElement;
const recordButton = document.getElementById('record-button') as HTMLButtonElement;
const switchCameraButton = document.getElementById('switch-camera-button') as HTMLButtonElement;
const saveButton = document.getElementById('save-button') as HTMLButtonElement;
const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
const zoomValueDisplay = document.getElementById('zoom-value') as HTMLSpanElement;
const errorMsgElement = document.getElementById('error-msg') as HTMLParagraphElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const ctx = canvas.getContext('2d');

let currentStream: MediaStream | null = null;
let currentZoom = 1.0;
let hasStartedDrawing = false;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let isRecording = false;
let mediaType: 'photo' | 'video' | null = null;
let videoDevices: MediaDeviceInfo[] = [];
let currentDeviceIndex = 0;


/**
 * Shows an error message to the user.
 * @param message The message to display.
 */
function showError(message: string) {
  errorMsgElement.textContent = message;
  errorMsgElement.hidden = false;
  console.error(message);
}

/**
 * Stops the current media stream tracks.
 */
function stopCurrentStream() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }
}

/**
 * Populates the camera selection dropdown.
 */
async function populateCameraList() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devices.filter(device => device.kind === 'videoinput');
        cameraSelect.innerHTML = '';

        if (videoDevices.length === 0) {
            switchCameraButton.hidden = true;
            const container = document.querySelector('.camera-selector-container');
            if (container) (container as HTMLElement).hidden = true;
            showError('利用可能なカメラが見つかりません。');
            return;
        }

        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `カメラ ${index + 1}`;
            cameraSelect.appendChild(option);
        });

        const controlsToToggle = [switchCameraButton, document.querySelector('.camera-selector-container')];
        controlsToToggle.forEach(el => {
            if (el) (el as HTMLElement).hidden = videoDevices.length <= 1;
        });

    } catch (err) {
        let message = 'カメラデバイスの取得中にエラーが発生しました。';
        if (err instanceof Error) {
            message += `\nError: ${err.message}`;
        }
        showError(message);
    }
}

/**
 * Initializes the camera and starts the video stream.
 * @param deviceId The optional device ID of the camera to use.
 */
async function initCamera(deviceId?: string) {
  stopCurrentStream();
  try {
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };

    if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
    } else if (videoDevices.length > 0) {
        videoConstraints.deviceId = { exact: videoDevices[0].deviceId };
    }

    const constraints = {
      video: videoConstraints,
      audio: true, // Request audio for recording
    };
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = currentStream;
    await video.play();

    // After getting permission, labels will be available. Repopulate if they were missing.
    if (videoDevices.length > 0 && !videoDevices[0].label) {
        await populateCameraList();
    }

    // Sync UI with the actual stream we got
    const currentTrack = currentStream.getVideoTracks()[0];
    const currentSettings = currentTrack.getSettings();
    if (currentSettings.deviceId) {
        const idx = videoDevices.findIndex(d => d.deviceId === currentSettings.deviceId);
        if (idx !== -1) {
            currentDeviceIndex = idx;
            cameraSelect.value = currentSettings.deviceId;
        }
    }

  } catch (err) {
    let message = 'カメラまたはマイクにアクセスできませんでした。デバイスが接続されており、アクセスが許可されていることを確認してください。';
    if (err instanceof Error) {
        message += `\nError: ${err.message}`;
    }
    showError(message);
  }
}

/**
 * Draws a single frame from the video to the canvas, applying the zoom.
 */
function drawFrame() {
  if (!ctx || video.paused || video.ended) {
    requestAnimationFrame(drawFrame);
    return;
  }

  const sourceWidth = video.videoWidth / currentZoom;
  const sourceHeight = video.videoHeight / currentZoom;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

  requestAnimationFrame(drawFrame);
}

/**
 * Captures a photo from the current canvas view.
 */
function takePicture() {
  if (!ctx) return;
  
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  
  const sourceWidth = video.videoWidth / currentZoom;
  const sourceHeight = video.videoHeight / currentZoom;

  tempCanvas.width = sourceWidth;
  tempCanvas.height = sourceHeight;

  if (tempCtx) {
    const sourceX = (video.videoWidth - sourceWidth) / 2;
    const sourceY = (video.videoHeight - sourceHeight) / 2;
    tempCtx.drawImage(
      video,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      tempCanvas.width,
      tempCanvas.height
    );
    const data = tempCanvas.toDataURL('image/jpeg', 0.9);
    photo.src = data;
    photo.hidden = false;
    recordedVideo.hidden = true;
    saveButton.hidden = false;
    saveButton.querySelector('span')!.textContent = '写真保存';
    mediaType = 'photo';
  }
}

/**
 * Toggles video recording on and off.
 */
function toggleRecording() {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
}

/**
 * Starts the video recording.
 */
function startRecording() {
    if (!currentStream || !ctx) {
        showError('録画を開始できません: カメラストリームまたは描画コンテキストが利用できません。');
        return;
    }

    // Get video stream from canvas (with zoom) and audio from original stream
    const canvasStream = canvas.captureStream();
    const audioTracks = currentStream.getAudioTracks();
    const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioTracks
    ]);

    recordedChunks = [];
    const options = { mimeType: 'video/webm; codecs=vp9,opus' };
    try {
        mediaRecorder = new MediaRecorder(combinedStream, options);
    } catch (e) {
        console.error('Exception while creating MediaRecorder:', e);
        showError(`お使いのブラウザはこの形式での録画をサポートしていません: ${options.mimeType}`);
        return;
    }

    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onstop = () => {
        const videoBlob = new Blob(recordedChunks, { type: 'video/mp4' });
        const videoUrl = URL.createObjectURL(videoBlob);
        recordedVideo.src = videoUrl;
        recordedVideo.hidden = false;
        photo.hidden = true;
        saveButton.hidden = false;
        saveButton.querySelector('span')!.textContent = '動画保存';
        mediaType = 'video';
    };
    
    mediaRecorder.start();
    isRecording = true;
    updateRecordingUI();
}

/**
 * Stops the video recording.
 */
function stopRecording() {
    if (mediaRecorder) {
        mediaRecorder.stop();
        isRecording = false;
        updateRecordingUI();
    }
}

/**
 * Updates the UI based on the recording state.
 */
function updateRecordingUI() {
    const recordButtonSpan = recordButton.querySelector('span')!;
    if (isRecording) {
        recordButton.classList.add('recording');
        recordButtonSpan.textContent = '停止';
        recordButton.setAttribute('aria-label', '録画を停止する');
        // Disable other controls
        captureButton.disabled = true;
        switchCameraButton.disabled = true;
        cameraSelect.disabled = true;
        zoomSlider.disabled = false; // Allow zoom during recording
    } else {
        recordButton.classList.remove('recording');
        recordButtonSpan.textContent = '録画';
        recordButton.setAttribute('aria-label', '録画を開始する');
        // Re-enable controls
        captureButton.disabled = false;
        switchCameraButton.disabled = videoDevices.length <= 1;
        cameraSelect.disabled = videoDevices.length <= 1;
        zoomSlider.disabled = false;
    }
}


/**
 * Saves the captured media (photo or video) by creating a download link.
 */
function saveMedia() {
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (mediaType === 'photo' && photo.src && photo.src !== window.location.href) {
        link.href = photo.src;
        link.download = `photo-${timestamp}.jpg`;
    } else if (mediaType === 'video' && recordedVideo.src) {
        link.href = recordedVideo.src;
        link.download = `video-${timestamp}.mp4`;
    } else {
        return; // Nothing to save
    }

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Handles changes from the zoom slider input.
 */
function handleZoomChange(event: Event) {
  const target = event.target as HTMLInputElement;
  currentZoom = parseFloat(target.value);
  zoomValueDisplay.textContent = currentZoom.toFixed(1);
}

/**
 * Switches to the next available camera.
 */
async function switchCamera() {
    if (videoDevices.length > 1) {
        currentDeviceIndex = (currentDeviceIndex + 1) % videoDevices.length;
        const device = videoDevices[currentDeviceIndex];
        cameraSelect.value = device.deviceId;
        zoomSlider.value = '1';
        currentZoom = 1.0;
        zoomValueDisplay.textContent = currentZoom.toFixed(1);
        await initCamera(device.deviceId);
    }
}

/**
 * Handles camera selection from the dropdown.
 */
async function handleCameraSelectChange() {
    const deviceId = cameraSelect.value;
    zoomSlider.value = '1';
    currentZoom = 1.0;
    zoomValueDisplay.textContent = currentZoom.toFixed(1);
    await initCamera(deviceId);
}

// Event Listeners
captureButton.addEventListener('click', takePicture);
recordButton.addEventListener('click', toggleRecording);
switchCameraButton.addEventListener('click', switchCamera);
zoomSlider.addEventListener('input', handleZoomChange);
saveButton.addEventListener('click', saveMedia);
cameraSelect.addEventListener('change', handleCameraSelectChange);

video.addEventListener('playing', () => {
    canvas.width = video.videoWidth / 2;
    canvas.height = video.videoHeight / 2;
    if (!hasStartedDrawing) {
        requestAnimationFrame(drawFrame);
        hasStartedDrawing = true;
    }
});


/**
 * Initializes the application.
 */
async function startApp() {
    await populateCameraList();
    await initCamera();
}

startApp();

window.addEventListener('beforeunload', () => {
    stopCurrentStream();
});

// Fix: Convert this file to a module to avoid global scope conflicts.
export {};
