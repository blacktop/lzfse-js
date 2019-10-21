# 🚧 lzfse.js 🚧

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![Build Status][travis-image]][travis-url]
[![Test Coverage][coveralls-image]][coveralls-url]

> This is a WASM Javascript implementation of the LZFSE compressor introduced in the Compression library with macOS 10.11 and iOS 9.

___

## Install

```bash
$ npm install lzfse.js
```

## Usage

```js
var fs = require('fs');
var asn = require('asn1.js');
var lzfse = require('lzfse.js');

var Img4 = asn.define('Img4', function() {
  this.seq().obj(
    this.key('IM4P').ia5str(),
    this.key('Name').ia5str(),
    this.key('Version').ia5str(),
    this.key('Data').octstr()
  );
});

var contents = fs.readFileSync('kernelcache');

var img4 = Img4.decode(contents, 'der');
console.log(img4.Version);

decoded_data = lzfse.decode_buffer(img4.Data)

fs.writeFile('kernelcache.decompressed', decoded_data, function (err) {
    if (err) {
        return console.log(err);
    }

    console.log("The file was saved!");
});
```

## License

MIT Copyright (c) 2019 blacktop

[npm-image]: https://img.shields.io/npm/v/lzfse.js.svg
[npm-url]: https://npmjs.org/package/lzfse.js
[travis-image]: https://img.shields.io/travis/blacktop/lzfse.js/master.svg
[travis-url]: https://travis-ci.org/blacktop/lzfse.js
[coveralls-image]: https://img.shields.io/coveralls/blacktop/lzfse.js/master.svg
[coveralls-url]: https://coveralls.io/r/blacktop/lzfse.js?branch=master
[downloads-image]: https://img.shields.io/npm/dm/lzfse.js.svg
[downloads-url]: https://npmjs.org/package/lzfse.js