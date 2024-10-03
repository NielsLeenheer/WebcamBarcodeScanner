import EventEmitter from './event-emitter.js';
import * as Comlink from 'comlink';

const TIME_BETWEEN_SCANS = 2 * 1000;
const WAIT_FOR_CAMERA = 2000;

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

class WebcamBarcodeScanner {
	
	#options;
	#internal;
	#state;
	#preview;

	#stats = {
		scans: 	0,
		time: 	null		
	}

    constructor(options) {
		this.#options = Object.assign({
			debug: 			false,
			allowTypes: 	null,
			useFallback: 	false,
			beepOnScan: 	true,
			resolution: 	{},
			workerPath: 	'webcam-barcode-scanner.worker.js',
			preview: 		{},
		}, options);

		this.#options.resolution = Object.assign({
			width:			1920,
			height:			1080
		}, this.#options.resolution);

		this.#options.preview = Object.assign({
			enabled: 		true,
			mirrored: 		true,
			hud: 			true,
			size: 			240,
			position: 		'bottom-right',
			padding: 		20,
			radius: 		6,
			zIndex: 		1000
		}, this.#options.preview);

		this.#internal = {
			devices:		[],
			current:		null,
			stream:			null,
            video:          null,
			buffer:			null,
			history:		new Map(),
            audio:          new AudioContext(),
			emitter:        new EventEmitter(),
            detector:       null,
        };

		this.#preview = {
			container:		null,
			hud:			null,
			video:			null,
			polygons:		new Map()
		};

		this.#state = {
			playing:		false,
			mirrored:		false
		};

		this.#setupDetectors();
		this.#cleanHistory();
	}

    async reconnect(previousDevice) {		
		await this.#waitUntilReady();
				
		if (this.#internal.detector == null) {
			return;
		}

		/* Initialize the webcam to get the video stream */

        let constraints = true;

        if (previousDevice.deviceId) {
            constraints = {
				width: this.#options.resolution.width,
				height: this.#options.resolution.height, 
                deviceId: { exact: previousDevice.deviceId }
            }
        }

        let stream = await navigator.mediaDevices.getUserMedia({ video: constraints });

        if (stream) {
			let location = 'front';
			let tracks = stream.getVideoTracks();

			for (let track of tracks) {
				let capabilities = track.getCapabilities();

				if (capabilities.facingMode) {
					location = capabilities.facingMode.length == 0 || capabilities.facingMode[0] == 'user' ? 'front' : 'back';
				}
			}

			this.#internal.stream = stream;
			this.#internal.current = previousDevice.deviceId;

			this.#state.mirrored = location == 'front';

			await this.#enumerate();

            this.#open(stream, previousDevice.deviceId);
        }
    }

    async connect() {
		await this.#waitUntilReady();
				
		if (this.#internal.detector == null) {
			return;
		}

		/* Initialize the webcam to get the video stream */

		let stream = await navigator.mediaDevices.getUserMedia({ video: this.#options.resolution });

        if (stream) {
			let deviceId = null;
			let location = 'front';

			let tracks = stream.getVideoTracks();

			for (let track of tracks) {
				let capabilities = track.getCapabilities();

				if (capabilities.facingMode) {
					location = capabilities.facingMode.length == 0 || capabilities.facingMode[0] == 'user' ? 'front' : 'back';
				}

				if (capabilities.deviceId) {
					deviceId = capabilities.deviceId;
				}
			}

			this.#internal.stream = stream;
			this.#internal.current = deviceId;

			this.#state.mirrored = location == 'front';

			await this.#enumerate();

			this.#open(stream, deviceId);
        }
    }
    
    async disconnect() {
        this.#close();
    }

    addEventListener(n, f) {
		this.#internal.emitter.on(n, f);
	}




	/* Private methods */



	/* Setup barcode detectors */

	#setupDetectors() {

		/* Use build-in BarcodeDetector */

		if ('BarcodeDetector' in window && !this.#options.useFallback) {
			this.#setupMainDetector();			
		}
		
		/* Fallback to Worker with WASM based detector */
		
		else if ('Worker' in window && 'WebAssembly' in window) {
			this.#setupFallbackDetector();
		}
    }

	#setupMainDetector() {
		const detector = new BarcodeDetector();

		this.#internal.detector = async (video) => {
			let barcodes = await detector.detect(video);
			
			let result = [];

			for (let barcode of barcodes) {
				let symbology = null;

				switch (barcode.format) {
					case 'ean_8':   symbology = 'ean8'; break;
					case 'ean_13':  symbology = 'ean13'; break;
					case 'upc_a':   symbology = 'upca'; break;
					case 'upc_e':   symbology = 'upce'; break;
					case 'code_39': symbology = 'code39'; break;
					case 'code_93': symbology = 'code93'; break;
					case 'code_128': symbology = 'code128'; break;
					case 'codabar': symbology = 'codabar'; break;
					case 'itf': symbology = 'interleaved-2-of-5'; break;
					case 'aztec':   symbology = 'aztec-code'; break;
					case 'data_matrix': symbology = 'data-matrix'; break;
					case 'qr_code': symbology = 'qr-code'; break;
					case 'pdf417': symbology = 'pdf417'; break;
				}


				result.push({
					value: barcode.rawValue,
					symbology,
					polygon: barcode.cornerPoints,
					raw: barcode
				});
			}

			return result;
		}
	}

	#setupFallbackDetector() {
		const worker = new Worker(this.#options.workerPath, {
			type: "module"
		});

		const detector = Comlink.wrap(worker);

		/* We use the first message from the worker to initialize the detector */

		worker.addEventListener('message', (e) => {
			let buffer = document.createElement('canvas');
			let context;
					
			this.#internal.detector = async (video) => {

				/* Create image buffer on the fly for getting the image data */

				if (!context) {
					buffer.height = video.videoHeight;
					buffer.width = video.videoWidth;
					context = buffer.getContext('2d', { willReadFrequently: true });
				}

				try {

					/* Draw video frame to buffer */

					let imageData;

					try {
						context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
						imageData = context.getImageData(0, 0, buffer.width, buffer.height);
					} catch (err) {
						context.reset();
						return [];
					}

					/* Convert image data to grayscale */

					const grayData = new Uint8Array(buffer.width * buffer.height);
					for (var i = 0, j = 0; i < imageData.data.length; i += 4, j++) {
						grayData[j] = (imageData.data[i] * 66 + imageData.data[i + 1] * 129 + imageData.data[i + 2] * 25 + 4096) >> 8;
					}
			
					/* Decode barcode */

					let barcode = await detector(buffer.width, buffer.height, grayData, {
						includePolygon: this.#options.preview.enabled && this.#options.preview.hud
					});

					if (barcode) {
						let symbology = null;
						
						switch (barcode.symbol) {
							case 'EAN-8':   	symbology = 'ean8'; break;
							case 'EAN-13':  	symbology = 'ean13'; break;
							case 'UPC-A':   	symbology = 'upca'; break;
							case 'UPC-E':   	symbology = 'upce'; break;
							case 'CODE-39': 	symbology = 'code39'; break;
							case 'CODE-93': 	symbology = 'code93'; break;
							case 'CODE-128': 	symbology = 'code128'; break;
							case 'Codabar': 	symbology = 'codabar'; break;
							case 'I2/5': 		symbology = 'interleaved-2-of-5'; break;
							case 'DataBar':   	symbology = 'gs1-databar-limited'; break;
							case 'DataBar-Exp': symbology = 'gs1-databar-expanded'; break;
							case 'QR-Code': 	symbology = 'qr-code'; break;
							case 'PDF417': 		symbology = 'pdf417'; break;
						}

						return [ {
							value: barcode.data, 
							symbology,
							polygon: barcode.polygon,
							raw: barcode
						} ];
					}
				} catch (err) {					
					console.error(err);
					throw err;
				}

				return [];
			};	
		}, { 
			once: true 
		});
	}

	async #waitUntilReady() {
		let count = 0;

		while(this.#internal.detector == null) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			count++;

			if (count > 10) {
				break;
			}
		}
	}


	/* Enumerate devices */

	async #enumerate() {
		let devices = await navigator.mediaDevices.enumerateDevices();

		for (let device of devices) {
			if (device.kind == 'videoinput') {
				let capabilities = device.getCapabilities();

				this.#internal.devices.push({
					label: 		device.label,
					deviceId:	device.deviceId,
					location: 	!capabilities.facingMode || capabilities.facingMode.length == 0 || capabilities.facingMode[0] == 'user' ? 'front' : 'back'
				});
			}
		}
	}

	/* Open, close and change video stream */

    async #open(stream, deviceId) {
        this.#internal.video = document.createElement('video');
        this.#internal.video.width = this.#options.resolution.width;
        this.#internal.video.height = this.#options.resolution.height;
        this.#internal.video.srcObject = stream;

        this.#internal.video.addEventListener('loadedmetadata', () => {
            this.#internal.video.play();
        });

		this.#internal.video.addEventListener('play', () => {
			this.#state.playing = true;
		});

        this.#internal.emitter.emit('connected', {
            type:       'webcam',
            deviceId:   deviceId
        });

		this.#lookForBarcodes();

		/* Create preview */

		if (this.#options.preview.enabled) {
			this.#createContainer();
			this.#preview.video = await this.#createPreview(stream);
		}
	}

	async #change(deviceId) {
		let device = this.#internal.devices.find(i => i.deviceId == deviceId);

		/* Keep a copy of the previous stream, so we can clean up after switching */
		
		let previousStream = this.#internal.stream;
		let previousPreview = this.#preview.video;

		/* 
		   On iOS we need to take a snapshot of the preview before switching, 
		   because iOS only supports one active stream 
		*/

		if (this.#options.preview.enabled && IS_IOS) {
			this.#snapshotPreview(this.#preview.video);
		} else {
			previousPreview.style.zIndex = 2;
		}

		/* Switch state */

		this.#state.playing = false;
		this.#state.mirrored = device.location == 'front';
			
		/* Open a new stream */

		let constraints = {
			width: 		this.#options.resolution.width,
			height: 	this.#options.resolution.height, 
			deviceId:	deviceId
		}

		let stream = await navigator.mediaDevices.getUserMedia({ video: constraints });

		if (stream) {
			this.#internal.stream = stream;
			this.#internal.current = deviceId;
			this.#internal.video.srcObject = stream;
			
			if (this.#options.preview.enabled) {
				this.#preview.video = await this.#createPreview(stream);

				/* Wait until the new preview has started playing */
				await Promise.race([
					new Promise(resolve => this.#preview.video.addEventListener('play', resolve, { once: true })),
					new Promise(resolve => setTimeout(resolve, WAIT_FOR_CAMERA))
				]);

				/* Wait a little longer, to prevent flickering */
				await new Promise((resolve) => setTimeout(resolve, 50));

				/* Remove the previous preview */
				await this.#destroyPreview(previousPreview);

				/* Now that the preview is no longer using it, we can stop the previous stream */
				let tracks = previousStream.getTracks();
				for (let track of tracks) {
					track.stop();
				}
			}
		}
	}

	async #close() {
		if (this.#preview.video) {
			await this.#destroyContainer();
		}

		this.#state.playing = false;

		if (this.#internal.video) {
			this.#internal.video.remove();
			this.#internal.video = null;
		}

		if (this.#internal.stream) {
			let tracks = this.#internal.stream.getTracks();
			for (let track of tracks) {
				track.stop();
			}

			this.#internal.stream = null;
		}

		this.#internal.current = null;
		this.#internal.emitter.emit('disconnected');
	}

	/* Video preview */

	#createContainer() {
		let width = this.#options.preview.size;
		let height = this.#options.resolution.height / this.#options.resolution.width * this.#options.preview.size;

		let container = document.createElement('div');
		container.style.opacity = 0;
		container.style.transition = 'opacity 0.4s';
		container.style.position = 'fixed';
		container.style.width = `${width}px`;
		container.style.height = `${height}px`;
		container.style.borderRadius = `${this.#options.preview.radius}px`;
		container.style.overflow = 'hidden';
		container.style.zIndex = this.#options.preview.zIndex;
		container.style.backgroundColor = 'black';

		switch (this.#options.preview.position) {
			case 'top-left':
				container.style.top = `${this.#options.preview.padding}px`;
				container.style.left = `${this.#options.preview.padding}px`;
				break;
			case 'top-right':
				container.style.top = `${this.#options.preview.padding}px`;
				container.style.right = `${this.#options.preview.padding}px`;
				break;
			case 'bottom-left':
				container.style.bottom = `${this.#options.preview.padding}px`;
				container.style.left = `${this.#options.preview.padding}px`;
				break;
			case 'bottom-right':
				container.style.bottom = `${this.#options.preview.padding}px`;
				container.style.right = `${this.#options.preview.padding}px`;
				break;
		}

		/* Create head up display */

		if (this.#options.preview.hud) {
			let hud = document.createElement('canvas');
			hud.width = this.#options.resolution.width;
			hud.height = this.#options.resolution.height;
			hud.style.width = `${width}px`;
			hud.style.height = `${height}px`;
			hud.style.position = 'absolute';
			hud.style.zIndex = 100;
			container.appendChild(hud);

			this.#preview.hud = hud.getContext('2d');
		}

		/* Create a menu to switch between cameras */

		let menu = document.createElement('select');
		menu.style.position = 'absolute';
		menu.style.zIndex = 102;
		menu.style.width = '30px';
		menu.style.height = '30px';
		menu.style.opacity = 0;
		menu.style.cursor = 'pointer';
		menu.style.appearance = 'none';

		for(let device of this.#internal.devices) {
			let option = document.createElement('option');
			option.value = device.deviceId;
			option.text = device.label;
			menu.appendChild(option);
		}

		menu.addEventListener('change', () => {
			this.#change(menu.value);
		});

		container.appendChild(menu);

		/* Create icon to indicate that the preview is clickable */

		let icon = document.createElement('div');
		icon.style.position = 'absolute';
		icon.style.zIndex = 101;
		icon.style.top = '5px';
		icon.style.left = '5px';
		icon.style.width = '20px';
		icon.style.height = '20px';
		icon.style.fontSize = '14px';
		icon.style.display = 'flex';
		icon.style.justifyContent = 'center';
		icon.style.alignItems = 'center';
		icon.style.backgroundColor = '#666666aa';
		icon.style.color = 'white';
		icon.style.borderRadius = '50%';
		icon.style.pointerEvents = 'none';
		icon.textContent = '▾';
		container.appendChild(icon);

		/* Append the container to the body */

		document.body.appendChild(container);
		this.#preview.container = container;

		/* Start drawing the hud */

		if (this.#options.preview.hud) {
			this.#drawHud();
		}
	}

	async #showContainer() {
		await new Promise((resolve) => setTimeout(resolve, 50));
		this.#preview.container.style.opacity = 1;
	}

	async #destroyContainer() {
		if (this.#preview.container) {
			this.#preview.container.style.opacity = 0;
	
			/* Wait for the transition to end before removing the snapshot */
	
			await new Promise((resolve) => this.#preview.container.ontransitionend = resolve);
	
			/* Remove the container */

			this.#preview.container.remove();
		}

		this.#preview.container = null;
		this.#preview.video = null;
	}

	#drawHud() {
		/* Clean up old polygons */

		let now = Date.now();

		for (let [key, value] of this.#preview.polygons) {
			if (now - value.timestamp > 300) {
				this.#preview.polygons.delete(key);
			}
		}

		/* Draw the left over polygons */

		let polygons = this.#preview.polygons.values();

		this.#preview.hud.clearRect(0, 0, this.#options.resolution.width, this.#options.resolution.height);
		this.#preview.hud.strokeStyle = 'lime';
		this.#preview.hud.lineWidth = 8;

		for (let { polygon } of polygons) {			
			this.#preview.hud.beginPath();

			if (this.#state.mirrored) {
				this.#preview.hud.moveTo(this.#options.resolution.width - polygon[0].x, polygon[0].y);
				for (let i = 1; i < polygon.length; i++) {
					this.#preview.hud.lineTo(this.#options.resolution.width - polygon[i].x, polygon[i].y);
				}
				this.#preview.hud.lineTo(this.#options.resolution.width - polygon[0].x, polygon[0].y);
			} else {
				this.#preview.hud.moveTo(polygon[0].x, polygon[0].y);
				for (let i = 1; i < polygon.length; i++) {
					this.#preview.hud.lineTo(polygon[i].x, polygon[i].y);
				}
				this.#preview.hud.lineTo(polygon[0].x, polygon[0].y);
			}

			this.#preview.hud.closePath();
			this.#preview.hud.stroke();
		}

		if (this.#preview.container) {
			requestAnimationFrame(() => this.#drawHud())
		}
	}

	async #createPreview(stream) {
		let preview = document.createElement('video');
		preview.width = this.#options.preview.size;
		preview.height = this.#options.resolution.height / this.#options.resolution.width * this.#options.preview.size;
        preview.srcObject = stream;

		preview.style.position = 'absolute';
		preview.style.zIndex = 1;
		preview.style.display = 'none';

		if (this.#state.mirrored && this.#options.preview.mirrored) {
			preview.style.transform = 'scaleX(-1)';
		}

		preview.addEventListener('loadedmetadata', () => {
            preview.play();
		});

		this.#preview.container.appendChild(preview);

		/* Wait for the preview to start playing */

		let result = await Promise.race([
			new Promise((resolve) => preview.addEventListener('play', resolve, { once: true })),
			new Promise((resolve) => setTimeout(resolve, WAIT_FOR_CAMERA))
		]);

		preview.style.display = 'block';
		this.#showContainer();

		return preview;
	}

	async #snapshotPreview(preview) {
		/* Create a canvas on the exact same spot as the preview video */

		let canvas = document.createElement('canvas');
		canvas.width = preview.width * window.devicePixelRatio;
		canvas.height = preview.height * window.devicePixelRatio;

		if (this.#state.mirrored && this.#options.preview.mirrored) {
			canvas.style.transform = 'scaleX(-1)';
		}

		canvas.style.position = 'absolute';
		canvas.style.width = `${preview.width}px`;
		canvas.style.height = `${preview.height}px`;
		canvas.style.borderRadius = `${this.#options.preview.radius}px`;
		canvas.style.zIndex = 99;
		canvas.style.backgroundColor = 'black';
		this.#preview.container.appendChild(canvas);
		
		/* Write the current frame of the video on the canvas */

		let context = canvas.getContext('2d');
		context.drawImage(preview, 0, 0, preview.width * window.devicePixelRatio, preview.height * window.devicePixelRatio);

		/* Give the new camera some time before fading out the snapshot */

		await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_CAMERA));

		canvas.style.transition = 'opacity 0.4s';
		canvas.style.opacity = 0;

		/* Wait for the transition to end before removing the snapshot */

		await new Promise((resolve) => canvas.ontransitionend = resolve);

		canvas.remove();
	}

	async #destroyPreview(preview) {
		if (preview) {
			preview.style.transition = 'opacity 0.4s';
			preview.style.opacity = 0;
	
			await new Promise((resolve) => preview.ontransitionend = resolve);

			preview.remove();
		}

		return null;
	}

	/* Handle barcode scan */

	#lookForBarcodes() {
		this.#stats.time = Date.now();

		setInterval(() => {
			if (this.#stats.scans > 0) {
				console.log(
					// `Scanned ${this.#stats.scans} barcodes in ${Date.now() - this.#stats.time}ms (average ${this.#stats.scans / (Date.now() - this.#stats.time) * 1000} scans/s`
				)

				this.#stats.time = Date.now();
				this.#stats.scans = 0;
			}
		}, 5000);

		let processFrame = async () => {

			/* Only process frames if the video is playing */

			if (this.#state.playing) {

				/* Detect barcodes in the video stream */

				let barcodes = await this.#internal.detector(this.#internal.video);
				
				/* Handle all detected barcodes */

				if (barcodes.length) {
					for (let barcode of barcodes) {
						this.#handleBarcode(barcode);
					}
				}

				this.#stats.scans++;
			} else {
				this.#stats.time = Date.now();
				this.#stats.scans = 0;
			}


			requestAnimationFrame(processFrame)
		};

		requestAnimationFrame(processFrame)
	}

    #handleBarcode(barcode) {

		/* Draw the location of the barcode */

		if (this.#options.preview.enabled && this.#options.preview.hud && barcode.polygon) {
			this.#preview.polygons.set(barcode.value, {
				timestamp: Date.now(),
				polygon: barcode.polygon,
			});
		}
		
		/* Make sure enough time has passed since we last scanned this barcode */

		if (this.#internal.history.has(barcode.value)) {
			return;
		}

		this.#internal.history.set(barcode.value, Date.now());

		/* If configured, only allow certain types of barcodes */

		if (this.#options.allowTypes && !this.#options.allowTypes.includes(barcode.symbology)) {
			return;
		}

		/* Beep on scan */

		if (this.#options.beepOnScan) {
			this.#beep();
		}

		/* Emit the barcode */

		let data = {
			value: 		barcode.value,
			symbology: 	barcode.symbology
		}

		if (this.#options.debug) {
			data.raw = barcode.raw;
		}

		this.#internal.emitter.emit('barcode', data);
    }

	#cleanHistory() {
		setInterval(() => {
			let now = Date.now();

			for (let [key, value] of this.#internal.history) {
				if (now - value > TIME_BETWEEN_SCANS) {
					this.#internal.history.delete(key);
				}
			}
		}, TIME_BETWEEN_SCANS);
	}

	/* Beep */

	#beep() {
		const duration = 80;
		const frequency = 2800;
		const volume = 100;
		
		if (this.#internal.audio.state == 'suspended') {
			this.#internal.audio.resume();
		}

		let oscillatorNode = this.#internal.audio.createOscillator();
		let gainNode = this.#internal.audio.createGain();
		
		oscillatorNode.connect(gainNode);
		oscillatorNode.frequency.value = frequency;
		oscillatorNode.type = "square";

		gainNode.connect(this.#internal.audio.destination);
		gainNode.gain.value = volume * 0.01;

		oscillatorNode.start(this.#internal.audio.currentTime);
		oscillatorNode.stop(this.#internal.audio.currentTime + duration * 0.001);
	}
}

export default WebcamBarcodeScanner;