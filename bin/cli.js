#! /usr/bin/env node

// const program = require('commander');
const chalk = require('chalk');

const fs = require('fs')
const path = require('path')
const testFile = path.join(__dirname, '../public/test/encoded.txt')

const lz = require('../public/lzfse')

const log = console.log;

// ES2015 template literal
const error = chalk.bold.red;
const warning = chalk.keyword('orange');

const tf = fs.existsSync(testFile)
if (!tf) {
    log(error(`TEST FILE ${testFile} doesn't exist.`))
}

// let lzfse_decode_buffer;

// lz['onRuntimeInitialized'] = () => {
const lzfse_decode_buffer = lz.cwrap('lzfse_decode_buffer', 'number', ['number', 'number', 'number', 'number', 'number'])
// }

// log(error('Error!'));
// log(warning('Warning!'));


// program
//     .option('--no-sauce', 'Remove sauce')
//     .option('--cheese <flavour>', 'cheese flavour', 'mozzarella')
//     .option('--no-cheese', 'plain with no cheese')
//     .parse(process.argv);

// const sauceStr = program.sauce ? 'sauce' : 'no sauce';
// const cheeseStr = (program.cheese === false) ? 'no cheese' : `${program.cheese} cheese`;
// log(warning(`You ordered a pizza with ${sauceStr} and ${cheeseStr}`));

let buffer
let destBuffer
let result

try {
    const arrayDataToPass = fs.readFileSync(testFile)
    // Init the typed array with the same length as the number of items in the array parameter
    const srcArray = new Uint8Array(arrayDataToPass.length)
    const destArray = new Uint8Array(4 * arrayDataToPass.length)

    // Populate the array with the values
    for (let i = 0; i < arrayDataToPass.length; i++) {
        srcArray[i] = arrayDataToPass[i]
    }

    // Allocate some space in the heap for the data (making sure to use the appropriate memory size of the elements)
    buffer = lz._malloc(srcArray.length * srcArray.BYTES_PER_ELEMENT)
    destBuffer = lz._malloc(destArray.length * destArray.BYTES_PER_ELEMENT)

    // Assign the data to the heap - Keep in mind bytes per element
    lz.HEAP8.set(srcArray, buffer >> 2)
    lz.HEAP8.set(destArray, destBuffer >> 2)

    // Finally, call the function with "number" parameter type for the array (the pointer), and an extra length parameter
    result = lz._lzfse_decode_buffer(destBuffer, destArray.length, buffer, srcArray.length)
    let string = new TextDecoder("utf-8").decode(destBuffer);
    log(string);

} catch (e) {
    log(error(e));
} finally {
    // To avoid memory leaks we need to always clear out the allocated heap data
    // This needs to happen in the finally block, otherwise thrown errors will stop code execution before this happens
    lz._free(buffer)
}
console.log(result)