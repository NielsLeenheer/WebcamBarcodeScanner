# WebcamBarcodeScanner

This is an library that allows you to use your webcam as a barcode scanner. 

### What does this library do?

This library uses the same API as `WebSerialBarcodeScanner` and `WebHIDBarcodeScanner`, which allows you to use external barcode scanners. But if you do not have an external barcode scanner, you can use this library as a drop-in replacement, or a fallback option using the webcam of your laptop or phone. 

### How to use it?

Load the `webcam-barcode-scanner.umd.js` file from the `dist` directory in the browser and instantiate a `WebcamBarcodeScanner` object. 

    <script src='webcam-barcode-scanner.umd.js'></script>

    <script>

        const barcodeScanner = new WebcamBarcodeScanner();

    </script>


Or import the `webcam-barcode-scanner.esm.js` module:

    import WebcamBarcodeScanner from 'webcam-barcode-scanner.esm.js';

    const barcodeScanner = new WebcamBarcodeScanner();


## Configuration

When you create the `WebcamBarcodeScanner` object you can specify a number of options to help with the library with connecting to the device. 


## Connect to a scanner

The first time you have to manually connect to the barcode scanner by calling the `connect()` function. This function must be called as the result of an user action, for example clicking a button. You cannot call this function on page load.

    function handleConnectButtonClick() {
        barcodeScanner.connect();
    }

Subsequent times you can simply call the `reconnect()` function. You have to provide an object with vendor id and product id of the previously connected barcode scanner in order to find the correct barcode scanner and connect to it again. If there is more than one device with the same vendor id and product id it won't be able to determine which of the two devices was previously used. So it will not reconnect. You can get the vendor id and product id by listening to the `connected` event and store it for later use. Unfortunately this is only available for USB connected devices. It is recommended to call this button on page load to prevent having to manually connect to a previously connected device.

    barcodeScanner.reconnect(lastUsedDevice);

If there are no barcode scanners connected that have been previously connected, this function will do nothing.

However, this library will actively look for new devices being connected. So if you connect a previously connected barcode scanner, it will immediately become available.

To find out when a barcode scanner is connected you can listen for the `connected` event using the `addEventListener()` function.

    barcodeScanner.addEventListener('connected', device => {
        console.log(`Connected to a device with vendorId: ${device.vendorId} and productId: ${device.productId}`);

        /* Store device for reconnecting */
        lastUsedDevice = device;
    });

The callback of the `connected` event is passed an object with the following properties:

-   `type`<br>
    Type of the connection that is used, in this case it is always `serial`.
-   `vendorId`<br>
    In case of a USB barcode scanner, the USB vendor ID.
-   `productId`<br>
    In case of a USB barcode scanner, the USB product ID.

To find out when a barcode scanner is disconnected you can listen for the `disconnected` event using the `addEventListener()` function.

    barcodeScanner.addEventListener('disconnected', () => {
        console.log(`Disconnected`);
    });

You can force the scanner to disconnect by calling the `disconnect()` function:

    barcodeScanner.disconnect();


## Events

Once connected you can use listen for the following events to receive data from the barcode scanner.

### Scanning barcodes

Whenever the libary detects a barcode, it will send out a `barcode` event that you can listen for.

barcodeScanner.addEventListener('barcode', e => {
    console.log(`Found barcode ${e.value}`);
});

The callback is passed an object with the following properties:

-   `value`<br>
    The value of the barcode as a string

## License

MIT
