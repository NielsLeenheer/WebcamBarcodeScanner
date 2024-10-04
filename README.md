# WebcamBarcodeScanner

This is an library that allows you to use your webcam as a barcode scanner. 

<br>

[![npm](https://img.shields.io/npm/v/@point-of-sale/webcam-barcode-scanner)](https://www.npmjs.com/@point-of-sale/webcam-barcode-scanner)
![GitHub License](https://img.shields.io/github/license/NielsLeenheer/WebcamBarcodeScanner)


> This library is part of [@point-of-sale](https://point-of-sale.dev), a collection of libraries for interfacing browsers and Node with Point of Sale devices such as receipt printers, barcode scanners and customer facing displays.

<br>

## What does this library do?

This library uses the same API as `WebSerialBarcodeScanner` and `WebHIDBarcodeScanner`, which allows you to use external barcode scanners. But if you do not have an external barcode scanner, you can use this library as a drop-in replacement, or a fallback option using the webcam of your laptop or phone. 

<br>

## How to use it?

Load the `webcam-barcode-scanner.umd.js` file from the `dist` directory in the browser and instantiate a `WebcamBarcodeScanner` object. 

```html
<script src='webcam-barcode-scanner.umd.js'></script>

<script>

    const barcodeScanner = new WebcamBarcodeScanner();

</script>
```

Or import the `webcam-barcode-scanner.esm.js` module:

```js
import WebcamBarcodeScanner from 'webcam-barcode-scanner.esm.js';

const barcodeScanner = new WebcamBarcodeScanner();
```

<br>

## Configuration

When you create the `WebcamBarcodeScanner` object you can specify a number of options to help with the library with connecting to the device. 

### Fallback worker support 

By default this library will try to use the build-in barcode detector support in Chromium browsers. As a fallback it uses a WASM version of ZXing running in a worker. That means you have to provide the library with the correct path to the worker library:

```js
const barcodeScanner = new WebcamBarcodeScanner({
    workerPath: '/dist/webcam-barcode-scanner.worker.js'
});
```

If you want to force the library to use WASM - which we would not advice - you can force the fallback:

```js
const barcodeScanner = new WebcamBarcodeScanner({
    workerPath: '/dist/webcam-barcode-scanner.worker.js',
    useFallback: true
});
```

### Beep on scan

By default this library will beep on a succesful scan, to mimick the sound an actual barcode scanner would make. If you want to disable this, you can do so:

```js
const barcodeScanner = new WebcamBarcodeScanner({
    beepOnScan: false
});
```

### Preview window

This library will show a small preview overlay on top of the current webpage with a view of your webcam. This will allow you to easily position the barcode in the right spot. 

You can configure the preview with the following options:

- `enabled`<br> 
    Turn the preview on or off
- `mirrored`<br>
    Mirror the image in the preview, so that movement mirrors your own
- `hud`<br> 
    Paint a border around detected barcodes on the preview
- `size`<br>
    Size of the preview in pixels
- `position`<br>
    Position of the preview, for example: `top-left`, `bottom-left`, `top-right` and `bottom-right`.
- `padding`<br>
    Space between the preview and the corner of the window
- `radius`<br>
    Border radius of the preview
- `zIndex`<br>
    Specify a z-index to make sure it is on top of your own content

For example:

```js
const barcodeScanner = new WebcamBarcodeScanner({
    preview: {
        enabled: false
    }
});
```

Or:

```js
const barcodeScanner = new WebcamBarcodeScanner({
    preview: {
        size: 		320,
        position: 	'bottom-left',
        padding: 	30,
        radius: 	10
    }
});
```


## Connect to a scanner

The first time you have to manually connect to the barcode scanner by calling the `connect()` function. This function must be called as the result of an user action, for example clicking a button. You cannot call this function on page load.

```js
function handleConnectButtonClick() {
    barcodeScanner.connect();
}
```

Subsequent times you can simply call the `reconnect()` function. You have to provide an object with vendor id and product id of the previously connected barcode scanner in order to find the correct barcode scanner and connect to it again. If there is more than one device with the same vendor id and product id it won't be able to determine which of the two devices was previously used. So it will not reconnect. You can get the vendor id and product id by listening to the `connected` event and store it for later use. Unfortunately this is only available for USB connected devices. It is recommended to call this button on page load to prevent having to manually connect to a previously connected device.

```js
    barcodeScanner.reconnect(lastUsedDevice);
```

If there are no barcode scanners connected that have been previously connected, this function will do nothing.

However, this library will actively look for new devices being connected. So if you connect a previously connected barcode scanner, it will immediately become available.

To find out when a barcode scanner is connected you can listen for the `connected` event using the `addEventListener()` function.

```js
barcodeScanner.addEventListener('connected', device => {
    console.log(`Connected to a webcam ${device.deviceId}`);

    /* Store device for reconnecting */
    lastUsedDevice = device;
});
```

The callback of the `connected` event is passed an object with the following properties:

-   `type`<br>
    Type of the connection that is used, in this case it is always `webcam`.
-   `deviceId`<br>
    The device id of the webcam.

To find out when the webcam is disconnected you can listen for the `disconnected` event using the `addEventListener()` function.

```js
barcodeScanner.addEventListener('disconnected', () => {
    console.log(`Disconnected`);
});
```

You can force the webcam to disconnect by calling the `disconnect()` function:

```js
barcodeScanner.disconnect();
```

## Events

Once connected you can use listen for the following events to receive data from the barcode scanner.

### Scanning barcodes

Whenever the libary detects a barcode, it will send out a `barcode` event that you can listen for.

```js
barcodeScanner.addEventListener('barcode', e => {
    console.log(`Found barcode ${e.value}`);
});
```

The callback is passed an object with the following properties:

-   `value`<br>
    The value of the barcode as a string

<br>

-----

<br>

This library has been created by Niels Leenheer under the [MIT license](LICENSE). Feel free to use it in your products. The  development of this library is sponsored by Salonhub.

<a href="https://salohub.nl"><img src="https://salonhub.nl/assets/images/salonhub.svg" width=140></a>
