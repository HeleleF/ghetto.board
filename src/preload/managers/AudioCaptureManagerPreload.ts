import { ipcRenderer } from "electron";
// @ts-ignore
import PCMStream from "./PCMStream.worklet";

/** Sample rate of the audio context */
const SAMPLE_RATE = 48000;
/** Number of channels for the audio context */
const NUM_CHANNELS = 2;
/** 16 bit audio data */
const BIT_DEPTH = 16;
/** Number of bytes per audio sample */
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;
/** 20ms Opus frame duration */
const FRAME_DURATION = 20;
/** Duration of each audio frame in seconds */
const FRAME_DURATION_SECONDS = FRAME_DURATION / 1000;
/**
 * Size in bytes of each frame of audio
 * We stream audio to the main context as 16bit PCM data
 * At 48KHz with a frame duration of 20ms (or 0.02s) and a stereo signal
 * our `frameSize` is calculated by:
 * `SAMPLE_RATE * FRAME_DURATION_SECONDS * NUM_CHANNELS / BYTES_PER_SAMPLE`
 * or:
 * `48000 * 0.02 * 2 / 2 = 960`
 */
const FRAME_SIZE =
  (SAMPLE_RATE * FRAME_DURATION_SECONDS * NUM_CHANNELS) / BYTES_PER_SAMPLE;

/**
 * Manager to capture audio from browser views and external audio devices
 * This class is to be run on the renderer thread
 * For the main thread counterpart see `AudioCaptureManagerMain.ts`
 */
export class AudioCaptureManagerPreload {
  /** Audio context to mix media streams into one audio output */
  _audioContext: AudioContext;
  /** Audio output node that streams will connect to */
  _audioOutputNode: AudioNode;

  /** Audio DOM element for the current output / local playback */
  _audioOutputElement: HTMLAudioElement;
  /** Raw media streams for each browser view containing webp/opus audio */
  _mediaStreams: Record<number, MediaStream>;
  _mediaStreamOutputs: Record<number, GainNode>;

  /** Raw media stream for each external audio source e.g. microphone or virtual audio cables */
  _externalAudioStreams: Record<string, MediaStream>;
  _externalAudioStreamOutputs: Record<string, GainNode>;

  _ws: WebSocket;

  constructor() {
    this._mediaStreams = {};
    this._mediaStreamOutputs = {};

    this._externalAudioStreams = {};
    this._externalAudioStreamOutputs = {};

    this._audioContext = new AudioContext({
      latencyHint: "playback",
      sampleRate: SAMPLE_RATE,
    });
    this._audioOutputNode = this._audioContext.createGain();
  }

  async setup() {
    await this._setupWebsocket();
    await this._setupLoopback();
  }

  async start(streamingMode: "lowLatency" | "performance") {
    await this._startBrowserStream(streamingMode);
  }

  setMuted(id: number, muted: boolean) {
    // Mute the audio context node
    // Note: we can't use `webContents.setAudioMuted()` as we are capturing a
    // separate audio stream then what is being sent to the user
    if (this._mediaStreamOutputs[id]) {
      this._mediaStreamOutputs[id].gain.value = muted ? 0 : 1;
    }
  }

  /**
   * Toggle the playback of the view audio in the current window
   * @param {boolean} loopback
   */
  setLoopback(loopback: boolean) {
    this._audioOutputElement.muted = !loopback;
  }

  async startExternalAudioCapture(deviceId: string) {
    try {
      const streamConfig = {
        audio: {
          deviceId: deviceId,
          noiseSuppression: false,
          autoGainControl: false,
          echoCancellation: false,
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(
        streamConfig as any
      );

      this._externalAudioStreams[deviceId] = stream;

      const output = this._audioContext.createGain();
      this._externalAudioStreamOutputs[deviceId] = output;

      const audioSource = this._audioContext.createMediaStreamSource(stream);
      audioSource.connect(output);

      output.connect(this._audioOutputNode);
    } catch (error) {
      console.error(
        `Unable to start stream for external audio device ${deviceId}`
      );
      console.error(error);
    }
  }

  stopExternalAudioCapture(deviceId: string) {
    const stream = this._externalAudioStreams[deviceId];
    if (stream) {
      for (let track of stream.getTracks()) {
        track.stop();
      }
      delete this._externalAudioStreams[deviceId];
      delete this._externalAudioStreamOutputs[deviceId];
    }
  }

  async _setupWebsocket() {
    const websocketAddress = await ipcRenderer.invoke(
      "AUDIO_CAPTURE_GET_WEBSOCKET_ADDRESS"
    );
    this._ws = new WebSocket(`ws://localhost:${websocketAddress.port}`);
    this._ws.addEventListener("close", (event) => {
      ipcRenderer.emit(
        "ERROR",
        null,
        `WebSocket closed with code ${event.code}`
      );
    });
  }

  async _setupLoopback() {
    // Create loopback media element
    const mediaDestination = this._audioContext.createMediaStreamDestination();
    this._audioOutputNode.connect(mediaDestination);

    this._audioOutputElement = document.createElement("audio");
    this._audioOutputElement.srcObject = mediaDestination.stream;
    this._audioOutputElement.onloadedmetadata = () => {
      this._audioOutputElement.play();
    };
  }

  /**
   * Start the internal PCM stream for communicating between the renderer and main context
   */
  async _startBrowserStream(streamingMode: "lowLatency" | "performance") {
    ipcRenderer.send(
      "AUDIO_CAPTURE_STREAM_START",
      NUM_CHANNELS,
      FRAME_SIZE,
      SAMPLE_RATE
    );

    // Create PCM stream node
    await this._audioContext.audioWorklet.addModule(PCMStream);
    const pcmStreamNode = new AudioWorkletNode(
      this._audioContext,
      "pcm-stream",
      {
        parameterData: {
          bufferSize: streamingMode === "lowLatency" ? 256 : 64000,
        },
      }
    );
    pcmStreamNode.port.onmessage = (event) => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(event.data);
      }
    };

    // Pipe the audio output into the stream
    this._audioOutputNode.connect(pcmStreamNode);
  }

  /**
   * Start an audio capture for the given browser view
   * @param viewId Browser view id
   * @param mediaSourceId The media source id to use with `getUserMedia`
   */
  async startBrowserViewStream(viewId: number, mediaSourceId: string) {
    try {
      const streamConfig = {
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: mediaSourceId,
          },
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(
        streamConfig as any
      );
      this._mediaStreams[viewId] = stream;

      const output = this._audioContext.createGain();
      this._mediaStreamOutputs[viewId] = output;

      const audioSource = this._audioContext.createMediaStreamSource(stream);
      audioSource.connect(output);

      output.connect(this._audioOutputNode);
    } catch (error) {
      console.error(`Unable to start stream for web view ${viewId}`);
      console.error(error);
    }
  }

  /**
   * Stop an audio capture for the given browser view
   * @param viewId Browser view id
   */
  stopBrowserViewStream(viewId: number) {
    if (this._mediaStreams[viewId]) {
      for (let track of this._mediaStreams[viewId].getTracks()) {
        track.stop();
      }
      delete this._mediaStreams[viewId];
    }
  }
}
