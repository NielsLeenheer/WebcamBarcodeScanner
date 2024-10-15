import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import omt from "@surma/rollup-plugin-off-main-thread";

export default [
	// browser-friendly UMD build
	{
		input: 'src/main.js',
		output: {
			name: 'WebcamBarcodeScanner',
			file: 'dist/webcam-barcode-scanner.umd.js',
			sourcemap: true,
			format: 'umd'
		},
		plugins: [
			resolve({ browser: true }), 
			commonjs(),
            terser() 
		]
	},

	{
		input: 'src/main.js',
		output: { 
			file: 'dist/webcam-barcode-scanner.esm.js', 
			sourcemap: true,
			format: 'es' 
		},
		plugins: [
			resolve({ browser: true }),
			commonjs(),
            terser()
		]
	},

	{
		input: 'src/worker.js',
		output: { 
			file: 'dist/webcam-barcode-scanner.worker.js', 
			sourcemap: false,
			format: 'amd' 
		},
		plugins: [
			resolve(),
			commonjs(),
            terser(),
			omt()
		]
	}
];
