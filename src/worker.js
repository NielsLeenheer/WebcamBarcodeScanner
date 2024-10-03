import * as Comlink from 'comlink';
import Module from './wasm/a.out.esm.js';
import hull from 'hull.js';

/* Send a message to the main thread to signal the module is loaded */

self.postMessage("ping");


/* Initialize the WASM module */

let api;
let result;

Module.onRuntimeInitialized = async () => {

    api = {
        scan_image: Module.cwrap('scan_image', '', ['number', 'number', 'number']),
        create_buffer: Module.cwrap('create_buffer', 'number', ['number', 'number']),
        destroy_buffer: Module.cwrap('destroy_buffer', '', ['number']),
    };
    
    Module['processResult'] = (symbol, data, polygon) => {
        result = {
            data,
            symbol,
            polygon
        };
    }
}


/* Function to decode barcode */

async function decodeBarcode(width, height, imageData, options) {
    try {
        result = null;

        const p = api.create_buffer(width, height);
        Module.HEAP8.set(imageData, p);
        api.scan_image(p, width, height)
        api.destroy_buffer(p);


        if (result) {
            /* Calculate concave hull for polygons */

            let polygon = [];

            if (options.includePolygon) {
                let points = [];

                for (let i = 0; i < result.polygon.length; i += 2) {
                    points.push([ result.polygon[i], result.polygon[i + 1] ]);
                }

                let hullPoints = hull(points, Infinity);
                polygon = hullPoints.map(point => ({ x: point[0], y: point[1] }));
            }

            return {
                data: result.data,
                symbol: result.symbol,
                polygon: polygon
            };
        }

        return result;
    }
    catch(err) {
        return null;
    }
}


/* Expose the function to the main thread */

Comlink.expose(decodeBarcode);
