import * as Comlink from 'comlink';
import { setZXingModuleOverrides, readBarcodesFromImageData } from "zxing-wasm/reader";


/* Initialize the ZXing module */

async function initialize(options) {
    setZXingModuleOverrides({
        locateFile: (path, prefix) => {
            if (path.endsWith(".wasm")) {
                return options.binaryPath;
            }

            return prefix + path;
        }
    });
}


/* Function to decode barcode */

async function decodeBarcode(imageData, options) {
    try {
        return await readBarcodesFromImageData(imageData, options);
    }
    catch(err) {
        return null;
    }
}


/* Expose the functions to the main thread */

Comlink.expose({
    initialize,
    decodeBarcode
});
