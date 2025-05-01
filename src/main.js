import EventEmitter from './event-emitter.js';
import { GS1 } from '@point-of-sale/barcode-parser';

import * as Comlink from 'comlink';
import { setZXingModuleOverrides, readBarcodesFromImageData } from "zxing-wasm/reader";
import '@interactjs/actions/drag';
import '@interactjs/auto-start';
import interact from '@interactjs/interact';



const TIME_BETWEEN_SCANS = 2 * 1000;
const WAIT_FOR_CAMERA = 2000;

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_IPHONE = /iPhone|iPod/.test(navigator.userAgent); 
const IS_IPAD = IS_IOS && !IS_IPHONE;

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
			allowedSymbologies: [],
			useFallback: 	false,
			useWorker: 		true,
			beepOnScan: 	true,
			resolution: 	{},
			workerPath: 	null,
			binaryPath:		null,
			preview: 		{},
		}, options);

		this.#options.resolution = Object.assign({
			width:			1920,
			height:			1080
		}, this.#options.resolution);

		this.#options.preview = Object.assign({
			enabled: 		true,
			draggable:		false,
			mirrored: 		true,
			hud: 			{},
			size: 			240,
			position: 		'bottom-right',
			padding: 		20,
			radius: 		6,
			zIndex: 		1000
		}, this.#options.preview);

		this.#options.preview.hud = Object.assign({
			enabled:		true,
			guide:			true,
			outline:		true,
		}, this.#options.preview.hud);

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
			width:			0,
			height:			0,
			orientation:	screen.orientation.angle === 0 ? 'normal' : 'rotated',
        };

		this.#preview = {
			width:			0,
			height:			0,
			container:		null,
			hud:			null,
			video:			null,
			polygons:		new Map()
		};

		this.#state = {
			playing:		false,
			mirrored:		false,
			changing:		false
		};


		/* Determine the path to the worker script and WASM binary */

		const currentPath = typeof import.meta !== 'undefined' ? 
			import.meta.url : document.currentScript.src;

		
		if (this.#options.workerPath === null) {
			this.#options.workerPath = 'webcam-barcode-scanner.worker.js';

			if (currentPath) {
				this.#options.workerPath = currentPath
					.replace(/webcam-barcode-scanner(\..*)?\.js/, this.#options.workerPath);
			}
		}

		if (this.#options.binaryPath === null) {
			this.#options.binaryPath = this.#options.workerPath
				.replace('webcam-barcode-scanner.worker.js', 'webcam-barcode-scanner.wasm')
		}


		/* Unmute the audio context */

		if (this.#internal.audio.state === 'suspended') {
			this.#internal.audio.resume();
		}


		/* Initialize the barcode scanner */

		this.#setupDetectors();
		this.#cleanHistory();

		screen.orientation.addEventListener("change", (event) => {
			this.#changeContainerOrientation();
		});
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
				if (!track.getCapabilities) {
					continue;
				}

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
				if (!track.getCapabilities) {
					continue;
				}

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

	async #setupFallbackDetector() {
		let workerFailed = false;

		if (this.#options.useWorker) {

			/* Work around potential origin issues by fetching the worker script and creating a blob URL */

			let response = await fetch(this.#options.workerPath);
			let script = URL.createObjectURL(new Blob([ await response.text() ], { type: 'application/javascript' }));

			/* Create the worker */

			try {
				const worker = new Worker(script, {
					type: "module"
				});

				worker.addEventListener('error', (e) => {
					console.log('Failed to create worker, using main thread for barcode detection, is your workerPath set correctly?');
					workerFailed = true;
				});

				let link = Comlink.wrap(worker);

				await link.initialize({
					binaryPath: this.#options.binaryPath
				});

				this.#runFallbackDetector(link.decodeBarcode);
			}
			catch (e) {
				console.log('Failed to create worker, using main thread for barcode detection, is your workerPath set correctly?', e);
				workerFailed = true;
			}
		}

		if (!this.#options.useWorker || workerFailed) {
			setZXingModuleOverrides({
				locateFile: (path, prefix) => {
				  if (path.endsWith(".wasm")) {
					return this.#options.binaryPath;
				  }

				  return prefix + path;
				},
			});

			this.#runFallbackDetector(readBarcodesFromImageData);
		}
	}

	#runFallbackDetector(detector) {
		let buffer = document.createElement('canvas');
		let width;
		let height;
		let context;
				
		this.#internal.detector = async (video) => {
			let result = [];

			if (context) {
				/* Width and height changed, so we need to change the buffer size */

				if (width != video.videoWidth || height != video.videoHeight) {
					width = buffer.width = video.videoWidth;
					height = buffer.height = video.videoHeight;
					context.reset();
				}
			}

			/* Create image buffer on the fly for getting the image data */

			else {
				width = buffer.width = video.videoWidth;
				height = buffer.height = video.videoHeight;
				context = buffer.getContext('2d', { willReadFrequently: true });
			}

			try {

				/* Draw video frame to buffer */

				let imageData;

				try {
					context.drawImage(video, 0, 0, width, height);
					imageData = context.getImageData(0, 0, width, height);
				} catch (err) {
					context.reset();
					return [];
				}

				/* Detect barcodes */

				let barcodes = await detector(imageData, {
					maxNumberOfSymbols: 1
				});


				if (barcodes && barcodes.length) {
					for(let barcode of barcodes) {
						if (barcode.error) {
							continue;
						}

						let symbology = null;

						switch (barcode.format) {
							case 'Aztec':   symbology = 'aztec-code'; break;
							case 'Codabar': symbology = 'codabar'; break;
							case 'Code39': symbology = 'code39'; break;
							case 'Code93': symbology = 'code93'; break;
							case 'Code128': symbology = 'code128'; break;
							case 'DataBar': symbology = 'gs1-databar-omni'; break;
							case 'DataBarExpanded': symbology = 'gs1-databar-expanded'; break;
							case 'DataMatrix': symbology = 'data-matrix'; break;
							case 'EAN-8':   symbology = 'ean8'; break;
							case 'EAN-13':  symbology = 'ean13'; break;
							case 'ITF': symbology = 'interleaved-2-of-5'; break;
							case 'MaxiCode': symbology = 'maxicode'; break;
							case 'QRCode': symbology = 'qr-code'; break;
							case 'PDF417': symbology = 'pdf417'; break;
							case 'UPCA':   symbology = 'upca'; break;
							case 'UPCE':   symbology = 'upce'; break;
							case 'MicroQRCode': symbology = 'qr-code-micro'; break;
							case 'RMQRCode': symbology = 'qr-code-micro'; break;
							case 'DXFilmEdge': symbology = 'dx-film-edge'; break;
						}

						if (symbology) {
							result.push({
								value: barcode.text,
								symbology,
								polygon: [
									{ x: barcode.position.topLeft.x, y: barcode.position.topLeft.y },
									{ x: barcode.position.topRight.x, y: barcode.position.topRight.y },
									{ x: barcode.position.bottomRight.x, y: barcode.position.bottomRight.y },
									{ x: barcode.position.bottomLeft.x, y: barcode.position.bottomLeft.y }
								],
								raw: barcode
							});
						}
					}					
				}
			} catch (err) {					
				console.error(err);
				throw err;
			}

			return result;
		}
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
				let location = 'front';

				if (device.getCapabilities) {
					let capabilities = device.getCapabilities();
					location = !capabilities.facingMode || capabilities.facingMode.length == 0 || capabilities.facingMode[0] == 'user' ? 'front' : 'back';
				}

				this.#internal.devices.push({
					label: 		device.label,
					deviceId:	device.deviceId,
					location
				});
			}
		}
	}

	/* Open, close and change video stream */

    async #open(stream, deviceId) {

		/* Determine the size of the stream */

		let width;
		let height;

		for (let track of stream.getVideoTracks()) {
			let settings = track.getSettings();
			if (settings) {
				width = track.getSettings().width;
				height = track.getSettings().height;
			}
		}

		this.#internal.width = width;
		this.#internal.height = height;

		if (IS_IOS) {
            let orientation = 'landscape';

            /* 
              For iPhones the default orientation is portrait and for iPads the default orientation is landscape, 
            */

            if (IS_IPHONE) {
                orientation = this.#internal.orientation === 'normal' ? 'portrait' : 'landscape';
            }
            else {
                orientation = this.#internal.orientation === 'normal' ? 'landscape' : 'portrait';
            }

            if (orientation === 'portrait') {
				this.#internal.width = Math.min(width, height);
				this.#internal.height = Math.max(width, height);
			}
			else {
				this.#internal.width = Math.max(width, height);
				this.#internal.height = Math.min(width, height);
			}
		}

		/* Create video element */

        this.#internal.video = document.createElement('video');
		this.#internal.video.playsInline = true;
		this.#internal.video.controls = false;
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

		/* Determine the size of our preview */

		let width = this.#options.preview.size;
		let height = this.#internal.height / this.#internal.width * this.#options.preview.size;
		
		if (this.#internal.width < this.#internal.height) {
			height = this.#options.preview.size;
			width = this.#internal.width / this.#internal.height * this.#options.preview.size;
		}

		this.#preview.width = width;
		this.#preview.height = height;

		/* Create container */

		let container = document.createElement('div');
		container.classList.add('webcam-barcode-scanner-preview');
		container.style.opacity = 0;
		container.style.transition = 'opacity 0.4s';
		container.style.position = 'fixed';
		container.style.width = `${this.#preview.width}px`;
		container.style.height = `${this.#preview.height}px`;
		container.style.borderRadius = `${this.#options.preview.radius}px`;
		container.style.overflow = 'hidden';
		container.style.zIndex = this.#options.preview.zIndex;
		container.style.backgroundColor = 'black';

		let padding = typeof this.#options.preview.padding !== 'number' ? this.#options.preview.padding : {
			top: this.#options.preview.padding,
			right: this.#options.preview.padding,
			bottom: this.#options.preview.padding,
			left: this.#options.preview.padding
		};

		switch (this.#options.preview.position) {
			case 'top-left':
				container.style.top = `${padding.top}px`;
				container.style.left = `${padding.left}px`;
				break;
			case 'top-right':
				container.style.top = `${padding.top}px`;
				container.style.right = `${padding.right}px`;
				break;
			case 'bottom-left':
				container.style.bottom = `${padding.bottom}px`;
				container.style.left = `${padding.left}px`;
				break;
			case 'bottom-right':
				container.style.bottom = `${padding.bottom}px`;
				container.style.right = `${padding.right}px`;
				break;
		}

		/* Make the preview draggable */
		
		if (this.#options.preview.draggable) {
			let position = { x: 0, y: 0 }
			let top, left, bottom, right;
			let x, y;

			let move = (event) => {
				position.x += event.dx
				position.y += event.dy

				event.target.style.transform = `translate(${position.x}px, ${position.y}px)`;
			};

			let end = async (event) => {
				let horizontal = event.pageX < window.innerWidth >> 1 ? 'left' : 'right';
				let vertical = event.pageY < window.innerHeight >> 1 ? 'top' : 'bottom';

				top = left = bottom = right = 'auto';

				if (horizontal == 'left') {
					left = `${padding.left}px`;
					x = padding.left;
				} else {
					right = `${padding.right}px`;
					x = window.innerWidth - event.target.clientWidth - padding.right;
				}

				if (vertical == 'top') {
					top = `${padding.top}px`;
					y = padding.top;
				} else {
					bottom = `${padding.bottom}px`;
					y = window.innerHeight - event.target.clientHeight - padding.bottom;
				}

				/* Animate the preview to its new location */

				let keyframes = [ { transform: `translate(${x - event.target.offsetLeft}px,${y - event.target.offsetTop}px` } ];
				let animation = event.target.animate(keyframes, {
					duration: 150,
				});

				await animation.finished;

				/* Swap transform for inset */

				container.style.inset = `${top} ${right} ${bottom} ${left}`;
				container.style.transform = '';

				/* Reset position */

				position.x = 0;
				position.y = 0;
			};

			interact('.webcam-barcode-scanner-preview').draggable({
				listeners: { move, end }
			});
		}

		/* Create head up display */

		if (this.#options.preview.hud.enabled) {
			let hud = document.createElement('canvas');
			hud.width = this.#internal.width;
			hud.height = this.#internal.height;
			hud.style.width = `${this.#preview.width}px`;
			hud.style.height = `${this.#preview.height}px`;
			hud.style.position = 'absolute';
			hud.style.zIndex = 100;
			hud.style.pointerEvents = 'none';
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

		if (this.#options.preview.hud.enabled) {
			this.#drawHud();
		}
	}

	async #changeContainerOrientation() {
		if (!this.#preview.container) {
			return;
		}

		this.#state.changing = true;

		let orientation = screen.orientation.angle === 0 ? 'normal' : 'rotated';
		let [ previewWidth, previewHeight ] = [ this.#preview.width, this.#preview.height ];
		let [ videoWidth, videoHeight ] = [ this.#internal.width, this.#internal.height ];

		if (this.#internal.orientation != orientation) {
			[ previewWidth, previewHeight ] = [ previewHeight, previewWidth ];
			[ videoWidth, videoHeight ] = [ videoHeight, videoWidth ];
		}

		/* Update sizes of the container and its children */

		this.#preview.container.style.width = `${previewWidth}px`;
		this.#preview.container.style.height = `${previewHeight}px`;

		let hud = this.#preview.container.querySelector('canvas');
		if (hud) {
			hud.width = videoWidth;
			hud.height = videoHeight;
			hud.style.width = `${previewWidth}px`;
			hud.style.height = `${previewHeight}px`;
		}

		let preview = this.#preview.container.querySelector('video');
		if (preview) {
			preview.width = previewWidth;
			preview.height = previewHeight;
		}

		await new Promise((resolve) => setTimeout(resolve, 500));

		this.#clearHud();
		this.#state.changing = false;
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

	#clearHud() {
		this.#preview.polygons.clear();
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

		let width = this.#preview.hud.canvas.width;
		let height = this.#preview.hud.canvas.height;

		this.#preview.hud.clearRect(0, 0, width, height);

		if (this.#options.preview.hud.guide && !this.#preview.polygons.size) {
			let s = 60;
			let x = width / 2;
			let y = height / 2;
			let w = width * 0.3;

			this.#preview.hud.strokeStyle = 'rgba(255, 0, 0, 0.3)';

			this.#preview.hud.beginPath();
			this.#preview.hud.lineWidth = 12;
			this.#preview.hud.moveTo(x - w - 6, y - s);
			this.#preview.hud.lineTo(x - w - 6, y + s);
			this.#preview.hud.moveTo(x + w + 6, y - s);
			this.#preview.hud.lineTo(x + w + 6, y + s);
			this.#preview.hud.stroke();

			this.#preview.hud.beginPath();
			this.#preview.hud.lineWidth = 36;
			this.#preview.hud.moveTo(x - w, y);
			this.#preview.hud.lineTo(x + w, y);
			this.#preview.hud.stroke();
		}

		if (this.#options.preview.hud.outline) {
			let polygons = this.#preview.polygons.values();

			if (!this.#state.changing) {
				this.#preview.hud.strokeStyle = 'lime';
				this.#preview.hud.lineWidth = 8;

				let zoom = this.#options.preview.zoom;

				let x = (width / 2) - (width * zoom / 2)
				let y = (height / 2) - (height * zoom / 2)

				for (let { polygon } of polygons) {		
					this.#preview.hud.beginPath();

					if (this.#state.mirrored) {
						this.#preview.hud.moveTo(x + ((width - polygon[0].x) * zoom), y + (polygon[0].y * zoom));
						for (let i = 1; i < polygon.length; i++) {
							this.#preview.hud.lineTo(x + ((width - polygon[i].x) * zoom), y + (polygon[i].y * zoom));
						}
						this.#preview.hud.lineTo(x + ((width - polygon[0].x) * zoom), y + (polygon[0].y * zoom));
					} else {
						this.#preview.hud.moveTo(x + polygon[0].x * zoom, y + (polygon[0].y * zoom));
						for (let i = 1; i < polygon.length; i++) {
							this.#preview.hud.lineTo(x + polygon[i].x * zoom, y + (polygon[i].y * zoom));
						}
						this.#preview.hud.lineTo(x + polygon[0].x * zoom, y + (polygon[0].y * zoom));
					}

					this.#preview.hud.closePath();
					this.#preview.hud.stroke();
				}
			}
		}

		if (this.#preview.container) {
			requestAnimationFrame(() => this.#drawHud())
		}
	}

	async #createPreview(stream) {
		let preview = document.createElement('video');
		preview.playsInline = true;
		preview.controls = false;
		preview.width = this.#preview.container.clientWidth;
		preview.height = this.#preview.container.clientHeight;
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
		this.#state.changing = true;

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

		this.#state.changing = false;
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
				if (this.#options.debug) {
					console.log(
						`Scanned ${this.#stats.scans} barcodes in ${Date.now() - this.#stats.time}ms (average ${this.#stats.scans / (Date.now() - this.#stats.time) * 1000} scans/s`
					)
				}

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

		if (this.#options.preview.enabled && this.#options.preview.hud.enabled && barcode.polygon) {
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

		if (this.#options.allowedSymbologies.length && !this.#options.allowedSymbologies.includes(barcode.symbology)) {
			return;
		}

		/* Beep on scan */

		if (this.#options.beepOnScan) {
			this.#beep();
		}

		/* Prepare the result */

		let result = {
			value: 		barcode.value,
			symbology: 	barcode.symbology,
			bytes: 		[ new Uint8Array(barcode.value.split('').map(c => c.charCodeAt(0))) ],
		}

		if (barcode.raw?.symbologyIdentifier) {
			result.aim = barcode.raw.symbologyIdentifier;
		}

		/* Decode GS1 data */

		let parsed = GS1.parse(result);
		if (parsed) {
			result.data = parsed;
		}
		
		if (this.#options.debug) {
			result.debug = barcode;
		}

		/* Emit the result */

		this.#internal.emitter.emit('barcode', result);
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