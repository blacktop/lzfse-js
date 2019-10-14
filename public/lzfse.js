// Copyright 2010 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module !== 'undefined' ? Module : {};

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
// {{PRE_JSES}}

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = {};
var key;
for (key in Module) {
  if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key];
  }
}

var arguments_ = [];
var thisProgram = './this.program';
var quit_ = function(status, toThrow) {
  throw toThrow;
};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

var ENVIRONMENT_IS_WEB = false;
var ENVIRONMENT_IS_WORKER = false;
var ENVIRONMENT_IS_NODE = false;
var ENVIRONMENT_HAS_NODE = false;
var ENVIRONMENT_IS_SHELL = false;
ENVIRONMENT_IS_WEB = typeof window === 'object';
ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
// A web environment like Electron.js can have Node enabled, so we must
// distinguish between Node-enabled environments and Node environments per se.
// This will allow the former to do things like mount NODEFS.
// Extended check using process.versions fixes issue #8816.
// (Also makes redundant the original check that 'require' is a function.)
ENVIRONMENT_HAS_NODE = typeof process === 'object' && typeof process.versions === 'object' && typeof process.versions.node === 'string';
ENVIRONMENT_IS_NODE = ENVIRONMENT_HAS_NODE && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER;
ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

if (Module['ENVIRONMENT']) {
  throw new Error('Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -s ENVIRONMENT=web or -s ENVIRONMENT=node)');
}


// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() thread proxied to worker. (with Emscripten -s PROXY_TO_WORKER=1) (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)




// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = '';
function locateFile(path) {
  if (Module['locateFile']) {
    return Module['locateFile'](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var read_,
    readAsync,
    readBinary,
    setWindowTitle;

if (ENVIRONMENT_IS_NODE) {
  scriptDirectory = __dirname + '/';

  // Expose functionality in the same simple way that the shells work
  // Note that we pollute the global namespace here, otherwise we break in node
  var nodeFS;
  var nodePath;

  read_ = function shell_read(filename, binary) {
    var ret;
    ret = tryParseAsDataURI(filename);
    if (!ret) {
      if (!nodeFS) nodeFS = require('fs');
      if (!nodePath) nodePath = require('path');
      filename = nodePath['normalize'](filename);
      ret = nodeFS['readFileSync'](filename);
    }
    return binary ? ret : ret.toString();
  };

  readBinary = function readBinary(filename) {
    var ret = read_(filename, true);
    if (!ret.buffer) {
      ret = new Uint8Array(ret);
    }
    assert(ret.buffer);
    return ret;
  };

  if (process['argv'].length > 1) {
    thisProgram = process['argv'][1].replace(/\\/g, '/');
  }

  arguments_ = process['argv'].slice(2);

  if (typeof module !== 'undefined') {
    module['exports'] = Module;
  }

  process['on']('uncaughtException', function(ex) {
    // suppress ExitStatus exceptions from showing an error
    if (!(ex instanceof ExitStatus)) {
      throw ex;
    }
  });

  process['on']('unhandledRejection', abort);

  quit_ = function(status) {
    process['exit'](status);
  };

  Module['inspect'] = function () { return '[Emscripten Module object]'; };
} else
if (ENVIRONMENT_IS_SHELL) {


  if (typeof read != 'undefined') {
    read_ = function shell_read(f) {
      var data = tryParseAsDataURI(f);
      if (data) {
        return intArrayToString(data);
      }
      return read(f);
    };
  }

  readBinary = function readBinary(f) {
    var data;
    data = tryParseAsDataURI(f);
    if (data) {
      return data;
    }
    if (typeof readbuffer === 'function') {
      return new Uint8Array(readbuffer(f));
    }
    data = read(f, 'binary');
    assert(typeof data === 'object');
    return data;
  };

  if (typeof scriptArgs != 'undefined') {
    arguments_ = scriptArgs;
  } else if (typeof arguments != 'undefined') {
    arguments_ = arguments;
  }

  if (typeof quit === 'function') {
    quit_ = function(status) {
      quit(status);
    };
  }

  if (typeof print !== 'undefined') {
    // Prefer to use print/printErr where they exist, as they usually work better.
    if (typeof console === 'undefined') console = {};
    console.log = print;
    console.warn = console.error = typeof printErr !== 'undefined' ? printErr : print;
  }
} else
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  if (ENVIRONMENT_IS_WORKER) { // Check worker, not web, since window could be polyfilled
    scriptDirectory = self.location.href;
  } else if (document.currentScript) { // web
    scriptDirectory = document.currentScript.src;
  }
  // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
  // otherwise, slice off the final part of the url to find the script directory.
  // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
  // and scriptDirectory will correctly be replaced with an empty string.
  if (scriptDirectory.indexOf('blob:') !== 0) {
    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf('/')+1);
  } else {
    scriptDirectory = '';
  }


  read_ = function shell_read(url) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      return xhr.responseText;
    } catch (err) {
      var data = tryParseAsDataURI(url);
      if (data) {
        return intArrayToString(data);
      }
      throw err;
    }
  };

  if (ENVIRONMENT_IS_WORKER) {
    readBinary = function readBinary(url) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.responseType = 'arraybuffer';
        xhr.send(null);
        return new Uint8Array(xhr.response);
      } catch (err) {
        var data = tryParseAsDataURI(url);
        if (data) {
          return data;
        }
        throw err;
      }
    };
  }

  readAsync = function readAsync(url, onload, onerror) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function xhr_onload() {
      if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
        onload(xhr.response);
        return;
      }
      var data = tryParseAsDataURI(url);
      if (data) {
        onload(data.buffer);
        return;
      }
      onerror();
    };
    xhr.onerror = onerror;
    xhr.send(null);
  };

  setWindowTitle = function(title) { document.title = title };
} else
{
  throw new Error('environment detection error');
}

// Set up the out() and err() hooks, which are how we can print to stdout or
// stderr, respectively.
var out = Module['print'] || console.log.bind(console);
var err = Module['printErr'] || console.warn.bind(console);

// Merge back in the overrides
for (key in moduleOverrides) {
  if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key];
  }
}
// Free the object hierarchy contained in the overrides, this lets the GC
// reclaim data used e.g. in memoryInitializerRequest, which is a large typed array.
moduleOverrides = null;

// Emit code to handle expected values on the Module object. This applies Module.x
// to the proper local x. This has two benefits: first, we only emit it if it is
// expected to arrive, and second, by using a local everywhere else that can be
// minified.
if (Module['arguments']) arguments_ = Module['arguments'];if (!Object.getOwnPropertyDescriptor(Module, 'arguments')) Object.defineProperty(Module, 'arguments', { get: function() { abort('Module.arguments has been replaced with plain arguments_') } });
if (Module['thisProgram']) thisProgram = Module['thisProgram'];if (!Object.getOwnPropertyDescriptor(Module, 'thisProgram')) Object.defineProperty(Module, 'thisProgram', { get: function() { abort('Module.thisProgram has been replaced with plain thisProgram') } });
if (Module['quit']) quit_ = Module['quit'];if (!Object.getOwnPropertyDescriptor(Module, 'quit')) Object.defineProperty(Module, 'quit', { get: function() { abort('Module.quit has been replaced with plain quit_') } });

// perform assertions in shell.js after we set up out() and err(), as otherwise if an assertion fails it cannot print the message
// Assertions on removed incoming Module JS APIs.
assert(typeof Module['memoryInitializerPrefixURL'] === 'undefined', 'Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['pthreadMainPrefixURL'] === 'undefined', 'Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['cdInitializerPrefixURL'] === 'undefined', 'Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['filePackagePrefixURL'] === 'undefined', 'Module.filePackagePrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['read'] === 'undefined', 'Module.read option was removed (modify read_ in JS)');
assert(typeof Module['readAsync'] === 'undefined', 'Module.readAsync option was removed (modify readAsync in JS)');
assert(typeof Module['readBinary'] === 'undefined', 'Module.readBinary option was removed (modify readBinary in JS)');
assert(typeof Module['setWindowTitle'] === 'undefined', 'Module.setWindowTitle option was removed (modify setWindowTitle in JS)');
if (!Object.getOwnPropertyDescriptor(Module, 'read')) Object.defineProperty(Module, 'read', { get: function() { abort('Module.read has been replaced with plain read_') } });
if (!Object.getOwnPropertyDescriptor(Module, 'readAsync')) Object.defineProperty(Module, 'readAsync', { get: function() { abort('Module.readAsync has been replaced with plain readAsync') } });
if (!Object.getOwnPropertyDescriptor(Module, 'readBinary')) Object.defineProperty(Module, 'readBinary', { get: function() { abort('Module.readBinary has been replaced with plain readBinary') } });
// TODO: add when SDL2 is fixed if (!Object.getOwnPropertyDescriptor(Module, 'setWindowTitle')) Object.defineProperty(Module, 'setWindowTitle', { get: function() { abort('Module.setWindowTitle has been replaced with plain setWindowTitle') } });


// TODO remove when SDL2 is fixed (also see above)



// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// {{PREAMBLE_ADDITIONS}}

var STACK_ALIGN = 16;

// stack management, and other functionality that is provided by the compiled code,
// should not be used before it is ready
stackSave = stackRestore = stackAlloc = function() {
  abort('cannot use the stack before compiled code is ready to run, and has provided stack access');
};

function staticAlloc(size) {
  abort('staticAlloc is no longer available at runtime; instead, perform static allocations at compile time (using makeStaticAlloc)');
}

function dynamicAlloc(size) {
  assert(DYNAMICTOP_PTR);
  var ret = HEAP32[DYNAMICTOP_PTR>>2];
  var end = (ret + size + 15) & -16;
  if (end > _emscripten_get_heap_size()) {
    abort('failure to dynamicAlloc - memory growth etc. is not supported there, call malloc/sbrk directly');
  }
  HEAP32[DYNAMICTOP_PTR>>2] = end;
  return ret;
}

function alignMemory(size, factor) {
  if (!factor) factor = STACK_ALIGN; // stack alignment (16-byte) by default
  return Math.ceil(size / factor) * factor;
}

function getNativeTypeSize(type) {
  switch (type) {
    case 'i1': case 'i8': return 1;
    case 'i16': return 2;
    case 'i32': return 4;
    case 'i64': return 8;
    case 'float': return 4;
    case 'double': return 8;
    default: {
      if (type[type.length-1] === '*') {
        return 4; // A pointer
      } else if (type[0] === 'i') {
        var bits = parseInt(type.substr(1));
        assert(bits % 8 === 0, 'getNativeTypeSize invalid bits ' + bits + ', type ' + type);
        return bits / 8;
      } else {
        return 0;
      }
    }
  }
}

function warnOnce(text) {
  if (!warnOnce.shown) warnOnce.shown = {};
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1;
    err(text);
  }
}

var asm2wasmImports = { // special asm2wasm imports
    "f64-rem": function(x, y) {
        return x % y;
    },
    "debugger": function() {
        debugger;
    }
};



var jsCallStartIndex = 1;
var functionPointers = new Array(0);


// 'sig' parameter is required for the llvm backend but only when func is not
// already a WebAssembly function.
function addFunction(func, sig) {
  assert(typeof func !== 'undefined');


  var base = 0;
  for (var i = base; i < base + 0; i++) {
    if (!functionPointers[i]) {
      functionPointers[i] = func;
      return jsCallStartIndex + i;
    }
  }
  throw 'Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS.';

}

function removeFunction(index) {

  functionPointers[index-jsCallStartIndex] = null;
}

var funcWrappers = {};

function getFuncWrapper(func, sig) {
  if (!func) return; // on null pointer, return undefined
  assert(sig);
  if (!funcWrappers[sig]) {
    funcWrappers[sig] = {};
  }
  var sigCache = funcWrappers[sig];
  if (!sigCache[func]) {
    // optimize away arguments usage in common cases
    if (sig.length === 1) {
      sigCache[func] = function dynCall_wrapper() {
        return dynCall(sig, func);
      };
    } else if (sig.length === 2) {
      sigCache[func] = function dynCall_wrapper(arg) {
        return dynCall(sig, func, [arg]);
      };
    } else {
      // general case
      sigCache[func] = function dynCall_wrapper() {
        return dynCall(sig, func, Array.prototype.slice.call(arguments));
      };
    }
  }
  return sigCache[func];
}


function makeBigInt(low, high, unsigned) {
  return unsigned ? ((+((low>>>0)))+((+((high>>>0)))*4294967296.0)) : ((+((low>>>0)))+((+((high|0)))*4294967296.0));
}

function dynCall(sig, ptr, args) {
  if (args && args.length) {
    assert(args.length == sig.length-1);
    assert(('dynCall_' + sig) in Module, 'bad function pointer type - no table for sig \'' + sig + '\'');
    return Module['dynCall_' + sig].apply(null, [ptr].concat(args));
  } else {
    assert(sig.length == 1);
    assert(('dynCall_' + sig) in Module, 'bad function pointer type - no table for sig \'' + sig + '\'');
    return Module['dynCall_' + sig].call(null, ptr);
  }
}

var tempRet0 = 0;

var setTempRet0 = function(value) {
  tempRet0 = value;
};

var getTempRet0 = function() {
  return tempRet0;
};

function getCompilerSetting(name) {
  throw 'You must build with -s RETAIN_COMPILER_SETTINGS=1 for getCompilerSetting or emscripten_get_compiler_setting to work';
}

var Runtime = {
  // helpful errors
  getTempRet0: function() { abort('getTempRet0() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
  staticAlloc: function() { abort('staticAlloc() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
  stackAlloc: function() { abort('stackAlloc() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
};

// The address globals begin at. Very low in memory, for code size and optimization opportunities.
// Above 0 is static memory, starting with globals.
// Then the stack.
// Then 'dynamic' memory for sbrk.
var GLOBAL_BASE = 8;




// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html


var wasmBinary;if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];if (!Object.getOwnPropertyDescriptor(Module, 'wasmBinary')) Object.defineProperty(Module, 'wasmBinary', { get: function() { abort('Module.wasmBinary has been replaced with plain wasmBinary') } });
var noExitRuntime;if (Module['noExitRuntime']) noExitRuntime = Module['noExitRuntime'];if (!Object.getOwnPropertyDescriptor(Module, 'noExitRuntime')) Object.defineProperty(Module, 'noExitRuntime', { get: function() { abort('Module.noExitRuntime has been replaced with plain noExitRuntime') } });




// In MINIMAL_RUNTIME, setValue() and getValue() are only available when building with safe heap enabled, for heap safety checking.
// In traditional runtime, setValue() and getValue() are always available (although their use is highly discouraged due to perf penalties)

/** @type {function(number, number, string, boolean=)} */
function setValue(ptr, value, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
      case 'i1': HEAP8[((ptr)>>0)]=value; break;
      case 'i8': HEAP8[((ptr)>>0)]=value; break;
      case 'i16': HEAP16[((ptr)>>1)]=value; break;
      case 'i32': HEAP32[((ptr)>>2)]=value; break;
      case 'i64': (tempI64 = [value>>>0,(tempDouble=value,(+(Math_abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math_min((+(Math_floor((tempDouble)/4294967296.0))), 4294967295.0))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296.0)))))>>>0) : 0)],HEAP32[((ptr)>>2)]=tempI64[0],HEAP32[(((ptr)+(4))>>2)]=tempI64[1]); break;
      case 'float': HEAPF32[((ptr)>>2)]=value; break;
      case 'double': HEAPF64[((ptr)>>3)]=value; break;
      default: abort('invalid type for setValue: ' + type);
    }
}

/** @type {function(number, string, boolean=)} */
function getValue(ptr, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
      case 'i1': return HEAP8[((ptr)>>0)];
      case 'i8': return HEAP8[((ptr)>>0)];
      case 'i16': return HEAP16[((ptr)>>1)];
      case 'i32': return HEAP32[((ptr)>>2)];
      case 'i64': return HEAP32[((ptr)>>2)];
      case 'float': return HEAPF32[((ptr)>>2)];
      case 'double': return HEAPF64[((ptr)>>3)];
      default: abort('invalid type for getValue: ' + type);
    }
  return null;
}





// Wasm globals

var wasmMemory;

// Potentially used for direct table calls.
var wasmTable;


//========================================
// Runtime essentials
//========================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS = 0;

/** @type {function(*, string=)} */
function assert(condition, text) {
  if (!condition) {
    abort('Assertion failed: ' + text);
  }
}

// Returns the C function with a specified identifier (for C++, you need to do manual name mangling)
function getCFunc(ident) {
  var func = Module['_' + ident]; // closure exported function
  assert(func, 'Cannot call unknown function ' + ident + ', make sure it is exported');
  return func;
}

// C calling interface.
function ccall(ident, returnType, argTypes, args, opts) {
  // For fast lookup of conversion functions
  var toC = {
    'string': function(str) {
      var ret = 0;
      if (str !== null && str !== undefined && str !== 0) { // null string
        // at most 4 bytes per UTF-8 code point, +1 for the trailing '\0'
        var len = (str.length << 2) + 1;
        ret = stackAlloc(len);
        stringToUTF8(str, ret, len);
      }
      return ret;
    },
    'array': function(arr) {
      var ret = stackAlloc(arr.length);
      writeArrayToMemory(arr, ret);
      return ret;
    }
  };

  function convertReturnValue(ret) {
    if (returnType === 'string') return UTF8ToString(ret);
    if (returnType === 'boolean') return Boolean(ret);
    return ret;
  }

  var func = getCFunc(ident);
  var cArgs = [];
  var stack = 0;
  assert(returnType !== 'array', 'Return type should not be "array".');
  if (args) {
    for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]];
      if (converter) {
        if (stack === 0) stack = stackSave();
        cArgs[i] = converter(args[i]);
      } else {
        cArgs[i] = args[i];
      }
    }
  }
  var ret = func.apply(null, cArgs);

  ret = convertReturnValue(ret);
  if (stack !== 0) stackRestore(stack);
  return ret;
}

function cwrap(ident, returnType, argTypes, opts) {
  return function() {
    return ccall(ident, returnType, argTypes, arguments, opts);
  }
}

var ALLOC_NORMAL = 0; // Tries to use _malloc()
var ALLOC_STACK = 1; // Lives for the duration of the current function call
var ALLOC_DYNAMIC = 2; // Cannot be freed except through sbrk
var ALLOC_NONE = 3; // Do not allocate

// allocate(): This is for internal use. You can use it yourself as well, but the interface
//             is a little tricky (see docs right below). The reason is that it is optimized
//             for multiple syntaxes to save space in generated code. So you should
//             normally not use allocate(), and instead allocate memory using _malloc(),
//             initialize it with setValue(), and so forth.
// @slab: An array of data, or a number. If a number, then the size of the block to allocate,
//        in *bytes* (note that this is sometimes confusing: the next parameter does not
//        affect this!)
// @types: Either an array of types, one for each byte (or 0 if no type at that position),
//         or a single type which is used for the entire block. This only matters if there
//         is initial data - if @slab is a number, then this does not matter at all and is
//         ignored.
// @allocator: How to allocate memory, see ALLOC_*
/** @type {function((TypedArray|Array<number>|number), string, number, number=)} */
function allocate(slab, types, allocator, ptr) {
  var zeroinit, size;
  if (typeof slab === 'number') {
    zeroinit = true;
    size = slab;
  } else {
    zeroinit = false;
    size = slab.length;
  }

  var singleType = typeof types === 'string' ? types : null;

  var ret;
  if (allocator == ALLOC_NONE) {
    ret = ptr;
  } else {
    ret = [_malloc,
    stackAlloc,
    dynamicAlloc][allocator](Math.max(size, singleType ? 1 : types.length));
  }

  if (zeroinit) {
    var stop;
    ptr = ret;
    assert((ret & 3) == 0);
    stop = ret + (size & ~3);
    for (; ptr < stop; ptr += 4) {
      HEAP32[((ptr)>>2)]=0;
    }
    stop = ret + size;
    while (ptr < stop) {
      HEAP8[((ptr++)>>0)]=0;
    }
    return ret;
  }

  if (singleType === 'i8') {
    if (slab.subarray || slab.slice) {
      HEAPU8.set(/** @type {!Uint8Array} */ (slab), ret);
    } else {
      HEAPU8.set(new Uint8Array(slab), ret);
    }
    return ret;
  }

  var i = 0, type, typeSize, previousType;
  while (i < size) {
    var curr = slab[i];

    type = singleType || types[i];
    if (type === 0) {
      i++;
      continue;
    }
    assert(type, 'Must know what type to store in allocate!');

    if (type == 'i64') type = 'i32'; // special case: we have one i32 here, and one i32 later

    setValue(ret+i, curr, type);

    // no need to look up size unless type changes, so cache it
    if (previousType !== type) {
      typeSize = getNativeTypeSize(type);
      previousType = type;
    }
    i += typeSize;
  }

  return ret;
}

// Allocate memory during any stage of startup - static memory early on, dynamic memory later, malloc when ready
function getMemory(size) {
  if (!runtimeInitialized) return dynamicAlloc(size);
  return _malloc(size);
}




/** @type {function(number, number=)} */
function Pointer_stringify(ptr, length) {
  abort("this function has been removed - you should use UTF8ToString(ptr, maxBytesToRead) instead!");
}

// Given a pointer 'ptr' to a null-terminated ASCII-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

function AsciiToString(ptr) {
  var str = '';
  while (1) {
    var ch = HEAPU8[((ptr++)>>0)];
    if (!ch) return str;
    str += String.fromCharCode(ch);
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in ASCII form. The copy will require at most str.length+1 bytes of space in the HEAP.

function stringToAscii(str, outPtr) {
  return writeAsciiToMemory(str, outPtr, false);
}


// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the given array that contains uint8 values, returns
// a copy of that string as a Javascript String object.

var UTF8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf8') : undefined;

/**
 * @param {number} idx
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ArrayToString(u8Array, idx, maxBytesToRead) {
  var endIdx = idx + maxBytesToRead;
  var endPtr = idx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  // (As a tiny code save trick, compare endPtr against endIdx using a negation, so that undefined means Infinity)
  while (u8Array[endPtr] && !(endPtr >= endIdx)) ++endPtr;

  if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
    return UTF8Decoder.decode(u8Array.subarray(idx, endPtr));
  } else {
    var str = '';
    // If building with TextDecoder, we have already computed the string length above, so test loop end condition against that
    while (idx < endPtr) {
      // For UTF8 byte structure, see:
      // http://en.wikipedia.org/wiki/UTF-8#Description
      // https://www.ietf.org/rfc/rfc2279.txt
      // https://tools.ietf.org/html/rfc3629
      var u0 = u8Array[idx++];
      if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
      var u1 = u8Array[idx++] & 63;
      if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
      var u2 = u8Array[idx++] & 63;
      if ((u0 & 0xF0) == 0xE0) {
        u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
      } else {
        if ((u0 & 0xF8) != 0xF0) warnOnce('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string on the asm.js/wasm heap to a JS string!');
        u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (u8Array[idx++] & 63);
      }

      if (u0 < 0x10000) {
        str += String.fromCharCode(u0);
      } else {
        var ch = u0 - 0x10000;
        str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
      }
    }
  }
  return str;
}

// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the emscripten HEAP, returns a
// copy of that string as a Javascript String object.
// maxBytesToRead: an optional length that specifies the maximum number of bytes to read. You can omit
//                 this parameter to scan the string until the first \0 byte. If maxBytesToRead is
//                 passed, and the string at [ptr, ptr+maxBytesToReadr[ contains a null byte in the
//                 middle, then the string will cut short at that byte index (i.e. maxBytesToRead will
//                 not produce a string of exact length [ptr, ptr+maxBytesToRead[)
//                 N.B. mixing frequent uses of UTF8ToString() with and without maxBytesToRead may
//                 throw JS JIT optimizations off, so it is worth to consider consistently using one
//                 style or the other.
/**
 * @param {number} ptr
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ToString(ptr, maxBytesToRead) {
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : '';
}

// Copies the given Javascript String object 'str' to the given byte array at address 'outIdx',
// encoded in UTF8 form and null-terminated. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outU8Array: the array to copy to. Each index in this array is assumed to be one 8-byte element.
//   outIdx: The starting offset in the array to begin the copying.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array.
//                    This count should include the null terminator,
//                    i.e. if maxBytesToWrite=1, only the null terminator will be written and nothing else.
//                    maxBytesToWrite=0 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8Array(str, outU8Array, outIdx, maxBytesToWrite) {
  if (!(maxBytesToWrite > 0)) // Parameter maxBytesToWrite is not optional. Negative values, 0, null, undefined and false each don't write out any bytes.
    return 0;

  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) {
      var u1 = str.charCodeAt(++i);
      u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
    }
    if (u <= 0x7F) {
      if (outIdx >= endIdx) break;
      outU8Array[outIdx++] = u;
    } else if (u <= 0x7FF) {
      if (outIdx + 1 >= endIdx) break;
      outU8Array[outIdx++] = 0xC0 | (u >> 6);
      outU8Array[outIdx++] = 0x80 | (u & 63);
    } else if (u <= 0xFFFF) {
      if (outIdx + 2 >= endIdx) break;
      outU8Array[outIdx++] = 0xE0 | (u >> 12);
      outU8Array[outIdx++] = 0x80 | ((u >> 6) & 63);
      outU8Array[outIdx++] = 0x80 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      if (u >= 0x200000) warnOnce('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to an UTF-8 string on the asm.js/wasm heap! (Valid unicode code points should be in range 0-0x1FFFFF).');
      outU8Array[outIdx++] = 0xF0 | (u >> 18);
      outU8Array[outIdx++] = 0x80 | ((u >> 12) & 63);
      outU8Array[outIdx++] = 0x80 | ((u >> 6) & 63);
      outU8Array[outIdx++] = 0x80 | (u & 63);
    }
  }
  // Null-terminate the pointer to the buffer.
  outU8Array[outIdx] = 0;
  return outIdx - startIdx;
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF8 form. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8(str, outPtr, maxBytesToWrite) {
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  return stringToUTF8Array(str, HEAPU8,outPtr, maxBytesToWrite);
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF8 byte array, EXCLUDING the null terminator byte.
function lengthBytesUTF8(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) u = 0x10000 + ((u & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF);
    if (u <= 0x7F) ++len;
    else if (u <= 0x7FF) len += 2;
    else if (u <= 0xFFFF) len += 3;
    else len += 4;
  }
  return len;
}


// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

var UTF16Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : undefined;
function UTF16ToString(ptr) {
  assert(ptr % 2 == 0, 'Pointer passed to UTF16ToString must be aligned to two bytes!');
  var endPtr = ptr;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  var idx = endPtr >> 1;
  while (HEAP16[idx]) ++idx;
  endPtr = idx << 1;

  if (endPtr - ptr > 32 && UTF16Decoder) {
    return UTF16Decoder.decode(HEAPU8.subarray(ptr, endPtr));
  } else {
    var i = 0;

    var str = '';
    while (1) {
      var codeUnit = HEAP16[(((ptr)+(i*2))>>1)];
      if (codeUnit == 0) return str;
      ++i;
      // fromCharCode constructs a character from a UTF-16 code unit, so we can pass the UTF16 string right through.
      str += String.fromCharCode(codeUnit);
    }
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF16 form. The copy will require at most str.length*4+2 bytes of space in the HEAP.
// Use the function lengthBytesUTF16() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=2, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<2 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF16(str, outPtr, maxBytesToWrite) {
  assert(outPtr % 2 == 0, 'Pointer passed to stringToUTF16 must be aligned to two bytes!');
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF16(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF;
  }
  if (maxBytesToWrite < 2) return 0;
  maxBytesToWrite -= 2; // Null terminator.
  var startPtr = outPtr;
  var numCharsToWrite = (maxBytesToWrite < str.length*2) ? (maxBytesToWrite / 2) : str.length;
  for (var i = 0; i < numCharsToWrite; ++i) {
    // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    HEAP16[((outPtr)>>1)]=codeUnit;
    outPtr += 2;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP16[((outPtr)>>1)]=0;
  return outPtr - startPtr;
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF16(str) {
  return str.length*2;
}

function UTF32ToString(ptr) {
  assert(ptr % 4 == 0, 'Pointer passed to UTF32ToString must be aligned to four bytes!');
  var i = 0;

  var str = '';
  while (1) {
    var utf32 = HEAP32[(((ptr)+(i*4))>>2)];
    if (utf32 == 0)
      return str;
    ++i;
    // Gotcha: fromCharCode constructs a character from a UTF-16 encoded code (pair), not from a Unicode code point! So encode the code point to UTF-16 for constructing.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    if (utf32 >= 0x10000) {
      var ch = utf32 - 0x10000;
      str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
    } else {
      str += String.fromCharCode(utf32);
    }
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF32 form. The copy will require at most str.length*4+4 bytes of space in the HEAP.
// Use the function lengthBytesUTF32() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=4, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<4 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF32(str, outPtr, maxBytesToWrite) {
  assert(outPtr % 4 == 0, 'Pointer passed to stringToUTF32 must be aligned to four bytes!');
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF32(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF;
  }
  if (maxBytesToWrite < 4) return 0;
  var startPtr = outPtr;
  var endPtr = startPtr + maxBytesToWrite - 4;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) {
      var trailSurrogate = str.charCodeAt(++i);
      codeUnit = 0x10000 + ((codeUnit & 0x3FF) << 10) | (trailSurrogate & 0x3FF);
    }
    HEAP32[((outPtr)>>2)]=codeUnit;
    outPtr += 4;
    if (outPtr + 4 > endPtr) break;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP32[((outPtr)>>2)]=0;
  return outPtr - startPtr;
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF32(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) ++i; // possibly a lead surrogate, so skip over the tail surrogate.
    len += 4;
  }

  return len;
}

// Allocate heap space for a JS string, and write it there.
// It is the responsibility of the caller to free() that memory.
function allocateUTF8(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8Array(str, HEAP8, ret, size);
  return ret;
}

// Allocate stack space for a JS string, and write it there.
function allocateUTF8OnStack(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8Array(str, HEAP8, ret, size);
  return ret;
}

// Deprecated: This function should not be called because it is unsafe and does not provide
// a maximum length limit of how many bytes it is allowed to write. Prefer calling the
// function stringToUTF8Array() instead, which takes in a maximum length that can be used
// to be secure from out of bounds writes.
/** @deprecated */
function writeStringToMemory(string, buffer, dontAddNull) {
  warnOnce('writeStringToMemory is deprecated and should not be called! Use stringToUTF8() instead!');

  var /** @type {number} */ lastChar, /** @type {number} */ end;
  if (dontAddNull) {
    // stringToUTF8Array always appends null. If we don't want to do that, remember the
    // character that existed at the location where the null will be placed, and restore
    // that after the write (below).
    end = buffer + lengthBytesUTF8(string);
    lastChar = HEAP8[end];
  }
  stringToUTF8(string, buffer, Infinity);
  if (dontAddNull) HEAP8[end] = lastChar; // Restore the value under the null character.
}

function writeArrayToMemory(array, buffer) {
  assert(array.length >= 0, 'writeArrayToMemory array must have a length (should be an array or typed array)')
  HEAP8.set(array, buffer);
}

function writeAsciiToMemory(str, buffer, dontAddNull) {
  for (var i = 0; i < str.length; ++i) {
    assert(str.charCodeAt(i) === str.charCodeAt(i)&0xff);
    HEAP8[((buffer++)>>0)]=str.charCodeAt(i);
  }
  // Null-terminate the pointer to the HEAP.
  if (!dontAddNull) HEAP8[((buffer)>>0)]=0;
}




// Memory management

var PAGE_SIZE = 16384;
var WASM_PAGE_SIZE = 65536;
var ASMJS_PAGE_SIZE = 16777216;

function alignUp(x, multiple) {
  if (x % multiple > 0) {
    x += multiple - (x % multiple);
  }
  return x;
}

var HEAP,
/** @type {ArrayBuffer} */
  buffer,
/** @type {Int8Array} */
  HEAP8,
/** @type {Uint8Array} */
  HEAPU8,
/** @type {Int16Array} */
  HEAP16,
/** @type {Uint16Array} */
  HEAPU16,
/** @type {Int32Array} */
  HEAP32,
/** @type {Uint32Array} */
  HEAPU32,
/** @type {Float32Array} */
  HEAPF32,
/** @type {Float64Array} */
  HEAPF64;

function updateGlobalBufferAndViews(buf) {
  buffer = buf;
  Module['HEAP8'] = HEAP8 = new Int8Array(buf);
  Module['HEAP16'] = HEAP16 = new Int16Array(buf);
  Module['HEAP32'] = HEAP32 = new Int32Array(buf);
  Module['HEAPU8'] = HEAPU8 = new Uint8Array(buf);
  Module['HEAPU16'] = HEAPU16 = new Uint16Array(buf);
  Module['HEAPU32'] = HEAPU32 = new Uint32Array(buf);
  Module['HEAPF32'] = HEAPF32 = new Float32Array(buf);
  Module['HEAPF64'] = HEAPF64 = new Float64Array(buf);
}


var STATIC_BASE = 8,
    STACK_BASE = 10064,
    STACKTOP = STACK_BASE,
    STACK_MAX = 5252944,
    DYNAMIC_BASE = 5252944,
    DYNAMICTOP_PTR = 10032;

assert(STACK_BASE % 16 === 0, 'stack must start aligned');
assert(DYNAMIC_BASE % 16 === 0, 'heap must start aligned');



var TOTAL_STACK = 5242880;
if (Module['TOTAL_STACK']) assert(TOTAL_STACK === Module['TOTAL_STACK'], 'the stack size can no longer be determined at runtime')

var INITIAL_TOTAL_MEMORY = Module['TOTAL_MEMORY'] || 16777216;if (!Object.getOwnPropertyDescriptor(Module, 'TOTAL_MEMORY')) Object.defineProperty(Module, 'TOTAL_MEMORY', { get: function() { abort('Module.TOTAL_MEMORY has been replaced with plain INITIAL_TOTAL_MEMORY') } });

assert(INITIAL_TOTAL_MEMORY >= TOTAL_STACK, 'TOTAL_MEMORY should be larger than TOTAL_STACK, was ' + INITIAL_TOTAL_MEMORY + '! (TOTAL_STACK=' + TOTAL_STACK + ')');

// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
assert(typeof Int32Array !== 'undefined' && typeof Float64Array !== 'undefined' && Int32Array.prototype.subarray !== undefined && Int32Array.prototype.set !== undefined,
       'JS engine does not provide full typed array support');







  if (Module['buffer']) {
    buffer = Module['buffer'];
  }
  else {
    buffer = new ArrayBuffer(INITIAL_TOTAL_MEMORY);
  }


// If the user provides an incorrect length, just use that length instead rather than providing the user to
// specifically provide the memory length with Module['TOTAL_MEMORY'].
INITIAL_TOTAL_MEMORY = buffer.byteLength;
updateGlobalBufferAndViews(buffer);

HEAP32[DYNAMICTOP_PTR>>2] = DYNAMIC_BASE;


// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie() {
  assert((STACK_MAX & 3) == 0);
  HEAPU32[(STACK_MAX >> 2)-1] = 0x02135467;
  HEAPU32[(STACK_MAX >> 2)-2] = 0x89BACDFE;
}

function checkStackCookie() {
  var cookie1 = HEAPU32[(STACK_MAX >> 2)-1];
  var cookie2 = HEAPU32[(STACK_MAX >> 2)-2];
  if (cookie1 != 0x02135467 || cookie2 != 0x89BACDFE) {
    abort('Stack overflow! Stack cookie has been overwritten, expected hex dwords 0x89BACDFE and 0x02135467, but received 0x' + cookie2.toString(16) + ' ' + cookie1.toString(16));
  }
  // Also test the global address 0 for integrity.
  // We don't do this with ASan because ASan does its own checks for this.
  if (HEAP32[0] !== 0x63736d65 /* 'emsc' */) abort('Runtime error: The application has corrupted its heap memory area (address zero)!');
}

function abortStackOverflow(allocSize) {
  abort('Stack overflow! Attempted to allocate ' + allocSize + ' bytes on the stack, but stack has only ' + (STACK_MAX - stackSave() + allocSize) + ' bytes available!');
}


  HEAP32[0] = 0x63736d65; /* 'emsc' */



// Endianness check (note: assumes compiler arch was little-endian)
HEAP16[1] = 0x6373;
if (HEAPU8[2] !== 0x73 || HEAPU8[3] !== 0x63) throw 'Runtime error: expected the system to be little-endian!';

function abortFnPtrError(ptr, sig) {
	abort("Invalid function pointer " + ptr + " called with signature '" + sig + "'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this). Build with ASSERTIONS=2 for more info.");
}



function callRuntimeCallbacks(callbacks) {
  while(callbacks.length > 0) {
    var callback = callbacks.shift();
    if (typeof callback == 'function') {
      callback();
      continue;
    }
    var func = callback.func;
    if (typeof func === 'number') {
      if (callback.arg === undefined) {
        Module['dynCall_v'](func);
      } else {
        Module['dynCall_vi'](func, callback.arg);
      }
    } else {
      func(callback.arg === undefined ? null : callback.arg);
    }
  }
}

var __ATPRERUN__  = []; // functions called before the runtime is initialized
var __ATINIT__    = []; // functions called during startup
var __ATMAIN__    = []; // functions called when main() is to be run
var __ATEXIT__    = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the main() is called

var runtimeInitialized = false;
var runtimeExited = false;


function preRun() {

  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }

  callRuntimeCallbacks(__ATPRERUN__);
}

function initRuntime() {
  checkStackCookie();
  assert(!runtimeInitialized);
  runtimeInitialized = true;
  if (!Module["noFSInit"] && !FS.init.initialized) FS.init();
TTY.init();
  callRuntimeCallbacks(__ATINIT__);
}

function preMain() {
  checkStackCookie();
  FS.ignorePermissions = false;
  callRuntimeCallbacks(__ATMAIN__);
}

function exitRuntime() {
  checkStackCookie();
  runtimeExited = true;
}

function postRun() {
  checkStackCookie();

  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }

  callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb);
}

function addOnInit(cb) {
  __ATINIT__.unshift(cb);
}

function addOnPreMain(cb) {
  __ATMAIN__.unshift(cb);
}

function addOnExit(cb) {
}

function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb);
}

function unSign(value, bits, ignore) {
  if (value >= 0) {
    return value;
  }
  return bits <= 32 ? 2*Math.abs(1 << (bits-1)) + value // Need some trickery, since if bits == 32, we are right at the limit of the bits JS uses in bitshifts
                    : Math.pow(2, bits)         + value;
}
function reSign(value, bits, ignore) {
  if (value <= 0) {
    return value;
  }
  var half = bits <= 32 ? Math.abs(1 << (bits-1)) // abs is needed if bits == 32
                        : Math.pow(2, bits-1);
  if (value >= half && (bits <= 32 || value > half)) { // for huge values, we can hit the precision limit and always get true here. so don't do that
                                                       // but, in general there is no perfect solution here. With 64-bit ints, we get rounding and errors
                                                       // TODO: In i64 mode 1, resign the two parts separately and safely
    value = -2*half + value; // Cannot bitshift half, as it may be at the limit of the bits JS uses in bitshifts
  }
  return value;
}


assert(Math.imul, 'This browser does not support Math.imul(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.fround, 'This browser does not support Math.fround(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.clz32, 'This browser does not support Math.clz32(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.trunc, 'This browser does not support Math.trunc(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');

var Math_abs = Math.abs;
var Math_cos = Math.cos;
var Math_sin = Math.sin;
var Math_tan = Math.tan;
var Math_acos = Math.acos;
var Math_asin = Math.asin;
var Math_atan = Math.atan;
var Math_atan2 = Math.atan2;
var Math_exp = Math.exp;
var Math_log = Math.log;
var Math_sqrt = Math.sqrt;
var Math_ceil = Math.ceil;
var Math_floor = Math.floor;
var Math_pow = Math.pow;
var Math_imul = Math.imul;
var Math_fround = Math.fround;
var Math_round = Math.round;
var Math_min = Math.min;
var Math_max = Math.max;
var Math_clz32 = Math.clz32;
var Math_trunc = Math.trunc;



// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// Module.preRun (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled
var runDependencyTracking = {};

function getUniqueRunDependency(id) {
  var orig = id;
  while (1) {
    if (!runDependencyTracking[id]) return id;
    id = orig + Math.random();
  }
  return id;
}

function addRunDependency(id) {
  runDependencies++;

  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }

  if (id) {
    assert(!runDependencyTracking[id]);
    runDependencyTracking[id] = 1;
    if (runDependencyWatcher === null && typeof setInterval !== 'undefined') {
      // Check for missing dependencies every few seconds
      runDependencyWatcher = setInterval(function() {
        if (ABORT) {
          clearInterval(runDependencyWatcher);
          runDependencyWatcher = null;
          return;
        }
        var shown = false;
        for (var dep in runDependencyTracking) {
          if (!shown) {
            shown = true;
            err('still waiting on run dependencies:');
          }
          err('dependency: ' + dep);
        }
        if (shown) {
          err('(end of list)');
        }
      }, 10000);
    }
  } else {
    err('warning: run dependency added without ID');
  }
}

function removeRunDependency(id) {
  runDependencies--;

  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }

  if (id) {
    assert(runDependencyTracking[id]);
    delete runDependencyTracking[id];
  } else {
    err('warning: run dependency removed without ID');
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback(); // can add another dependenciesFulfilled
    }
  }
}

Module["preloadedImages"] = {}; // maps url to image data
Module["preloadedAudios"] = {}; // maps url to audio data


var memoryInitializer = null;







// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// Prefix of data URIs emitted by SINGLE_FILE and related options.
var dataURIPrefix = 'data:application/octet-stream;base64,';

// Indicates whether filename is a base64 data URI.
function isDataURI(filename) {
  return String.prototype.startsWith ?
      filename.startsWith(dataURIPrefix) :
      filename.indexOf(dataURIPrefix) === 0;
}





// Globals used by JS i64 conversions
var tempDouble;
var tempI64;

// === Body ===

var ASM_CONSTS = [];





// STATICTOP = STATIC_BASE + 10056;
/* global initializers */ /*__ATINIT__.push();*/


memoryInitializer = "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAQEBAQICAgIDAwMDBAQEBAUFBQUGBgYGBwcHBwgICAgJCQkJCgoKCgsLCwsMDAwMDQ0NDQ4ODg4PDw8PAAAAAAEAAAACAAAAAwAAAAQAAAAGAAAACAAAAAoAAAAMAAAAEAAAABQAAAAYAAAAHAAAACQAAAAsAAAANAAAADwAAABMAAAAXAAAAGwAAAB8AAAAnAAAALwAAADcAAAA/AAAADwBAAB8AQAAvAEAAPwBAAB8AgAA/AIAAHwDAAD8AwAA/AQAAPwFAAD8BgAA/AcAAPwJAAD8CwAA/A0AAPwPAAD8EwAA/BcAAPwbAAD8HwAA/CcAAPwvAAD8NwAA/D8AAPxPAAD8XwAA/G8AAPx/AAD8nwAA/L8AAPzfAAD8/wAA/D8BAPx/AQD8vwEA/P8BAPx/AgD8/wIA/H8DAAAAAAAAAAAAAAAAAAAAAAADBQgLAAAAAAAAAAAAAAAAAAAAAAEAAAACAAAAAwAAAAQAAAAFAAAABgAAAAcAAAAIAAAACQAAAAoAAAALAAAADAAAAA0AAAAOAAAADwAAABAAAAAYAAAAOAAAADgBAAAAAAAAAAAAAAAAAAAAAAAAAgMFCAAAAAAAAAAAAAAAAAAAAAABAAAAAgAAAAMAAAAEAAAABQAAAAYAAAAHAAAACAAAAAkAAAAKAAAACwAAAAwAAAANAAAADgAAAA8AAAAQAAAAFAAAABwAAAA8AAAAAAECAwQEBQUGBgcHCAgICAkJCQkKCgoKCwsLCwwMDAwMDAwMDQ0NDQ0NDQ0ODg4ODg4ODg8PDw8PDw8PEBAQEBAREhMUFBUVFhYXFxgYGBgZGRkZGhoaGhsbGxscHBwcHBwcHB0dHR0dHR0dHh4eHh4eHh4fHx8fHx8fHyAgICAgISIjJCQlJSYmJycoKCgoKSkpKSoqKiorKysrLCwsLCwsLCwtLS0tLS0tLS4uLi4uLi4uLy8vLy8vLy8wMDAwMDEyMzQ0NTU2Njc3ODg4ODk5OTk6Ojo6Ozs7Ozw8PDw8PDw8PT09PT09PT0+Pj4+Pj4+Pj8/Pz8/Pz8/AAAAAAABAgMEBQYHCAkKCwwNDg8QEBAQEBAQEBEREREREREREREREREREREREREREREREREREREREREREhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTAAAAAAAAAAAAAQIDBAUGBwgJCgsMDQ4PEBAQEBEREREREREREhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhITExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTAAAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAcAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAACwAAAAgAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAALAAAACAAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAYAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAABgAAAAgAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAAGAAAACAAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAYAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAABgAAAAgAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAAJAAAACAAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAkAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAACQAAAAgAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAAJAAAACAAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAkAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAACQAAAAgAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAACQAAAAgAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAAJAAAACAAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAkAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAACQAAAAgAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAkAAAAIAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAACQAAAAgAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABgAAAAYAAAAGAAAABQAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAMAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAAAAAAAAQAAAAMAAAAHAAAADwAAAB8AAAA/AAAAfwAAAP8AAAD/AQAA/wMAAP8HAAD/DwAA/x8AAP8/AAD/fwAA//8AAP//AQD//wMA//8HAP//DwD//x8A//8/AP//fwD///8A////Af///wP///8H////D////x////8/////f/////8AAAAAAAAAAAAAAAACAwIFAgMCCAIDAgUCAwIOAgMCBQIDAggCAwIFAgMCDgACAQQAAwH/AAIBBQADAf8AAgEGAAMB/wACAQcAAwH/EQAKABEREQAAAAAFAAAAAAAACQAAAAALAAAAAAAAAAARAA8KERERAwoHAAETCQsLAAAJBgsAAAsABhEAAAAREREAAAAAAAAAAAAAAAAAAAAACwAAAAAAAAAAEQAKChEREQAKAAACAAkLAAAACQALAAALAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAwAAAAADAAAAAAJDAAAAAAADAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAANAAAABA0AAAAACQ4AAAAAAA4AAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAADwAAAAAPAAAAAAkQAAAAAAAQAAAQAAASAAAAEhISAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAAASEhIAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALAAAAAAAAAAAAAAAKAAAAAAoAAAAACQsAAAAAAAsAAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAADAAAAAAMAAAAAAkMAAAAAAAMAAAMAAAwMTIzNDU2Nzg5QUJDREVGVCEiGQ0BAgMRSxwMEAQLHRIeJ2hub3BxYiAFBg8TFBUaCBYHKCQXGAkKDhsfJSODgn0mKis8PT4/Q0dKTVhZWltcXV5fYGFjZGVmZ2lqa2xyc3R5ent8AAAAAAAAAAAASWxsZWdhbCBieXRlIHNlcXVlbmNlAERvbWFpbiBlcnJvcgBSZXN1bHQgbm90IHJlcHJlc2VudGFibGUATm90IGEgdHR5AFBlcm1pc3Npb24gZGVuaWVkAE9wZXJhdGlvbiBub3QgcGVybWl0dGVkAE5vIHN1Y2ggZmlsZSBvciBkaXJlY3RvcnkATm8gc3VjaCBwcm9jZXNzAEZpbGUgZXhpc3RzAFZhbHVlIHRvbyBsYXJnZSBmb3IgZGF0YSB0eXBlAE5vIHNwYWNlIGxlZnQgb24gZGV2aWNlAE91dCBvZiBtZW1vcnkAUmVzb3VyY2UgYnVzeQBJbnRlcnJ1cHRlZCBzeXN0ZW0gY2FsbABSZXNvdXJjZSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZQBJbnZhbGlkIHNlZWsAQ3Jvc3MtZGV2aWNlIGxpbmsAUmVhZC1vbmx5IGZpbGUgc3lzdGVtAERpcmVjdG9yeSBub3QgZW1wdHkAQ29ubmVjdGlvbiByZXNldCBieSBwZWVyAE9wZXJhdGlvbiB0aW1lZCBvdXQAQ29ubmVjdGlvbiByZWZ1c2VkAEhvc3QgaXMgZG93bgBIb3N0IGlzIHVucmVhY2hhYmxlAEFkZHJlc3MgaW4gdXNlAEJyb2tlbiBwaXBlAEkvTyBlcnJvcgBObyBzdWNoIGRldmljZSBvciBhZGRyZXNzAEJsb2NrIGRldmljZSByZXF1aXJlZABObyBzdWNoIGRldmljZQBOb3QgYSBkaXJlY3RvcnkASXMgYSBkaXJlY3RvcnkAVGV4dCBmaWxlIGJ1c3kARXhlYyBmb3JtYXQgZXJyb3IASW52YWxpZCBhcmd1bWVudABBcmd1bWVudCBsaXN0IHRvbyBsb25nAFN5bWJvbGljIGxpbmsgbG9vcABGaWxlbmFtZSB0b28gbG9uZwBUb28gbWFueSBvcGVuIGZpbGVzIGluIHN5c3RlbQBObyBmaWxlIGRlc2NyaXB0b3JzIGF2YWlsYWJsZQBCYWQgZmlsZSBkZXNjcmlwdG9yAE5vIGNoaWxkIHByb2Nlc3MAQmFkIGFkZHJlc3MARmlsZSB0b28gbGFyZ2UAVG9vIG1hbnkgbGlua3MATm8gbG9ja3MgYXZhaWxhYmxlAFJlc291cmNlIGRlYWRsb2NrIHdvdWxkIG9jY3VyAFN0YXRlIG5vdCByZWNvdmVyYWJsZQBQcmV2aW91cyBvd25lciBkaWVkAE9wZXJhdGlvbiBjYW5jZWxlZABGdW5jdGlvbiBub3QgaW1wbGVtZW50ZWQATm8gbWVzc2FnZSBvZiBkZXNpcmVkIHR5cGUASWRlbnRpZmllciByZW1vdmVkAERldmljZSBub3QgYSBzdHJlYW0ATm8gZGF0YSBhdmFpbGFibGUARGV2aWNlIHRpbWVvdXQAT3V0IG9mIHN0cmVhbXMgcmVzb3VyY2VzAExpbmsgaGFzIGJlZW4gc2V2ZXJlZABQcm90b2NvbCBlcnJvcgBCYWQgbWVzc2FnZQBGaWxlIGRlc2NyaXB0b3IgaW4gYmFkIHN0YXRlAE5vdCBhIHNvY2tldABEZXN0aW5hdGlvbiBhZGRyZXNzIHJlcXVpcmVkAE1lc3NhZ2UgdG9vIGxhcmdlAFByb3RvY29sIHdyb25nIHR5cGUgZm9yIHNvY2tldABQcm90b2NvbCBub3QgYXZhaWxhYmxlAFByb3RvY29sIG5vdCBzdXBwb3J0ZWQAU29ja2V0IHR5cGUgbm90IHN1cHBvcnRlZABOb3Qgc3VwcG9ydGVkAFByb3RvY29sIGZhbWlseSBub3Qgc3VwcG9ydGVkAEFkZHJlc3MgZmFtaWx5IG5vdCBzdXBwb3J0ZWQgYnkgcHJvdG9jb2wAQWRkcmVzcyBub3QgYXZhaWxhYmxlAE5ldHdvcmsgaXMgZG93bgBOZXR3b3JrIHVucmVhY2hhYmxlAENvbm5lY3Rpb24gcmVzZXQgYnkgbmV0d29yawBDb25uZWN0aW9uIGFib3J0ZWQATm8gYnVmZmVyIHNwYWNlIGF2YWlsYWJsZQBTb2NrZXQgaXMgY29ubmVjdGVkAFNvY2tldCBub3QgY29ubmVjdGVkAENhbm5vdCBzZW5kIGFmdGVyIHNvY2tldCBzaHV0ZG93bgBPcGVyYXRpb24gYWxyZWFkeSBpbiBwcm9ncmVzcwBPcGVyYXRpb24gaW4gcHJvZ3Jlc3MAU3RhbGUgZmlsZSBoYW5kbGUAUmVtb3RlIEkvTyBlcnJvcgBRdW90YSBleGNlZWRlZABObyBtZWRpdW0gZm91bmQAV3JvbmcgbWVkaXVtIHR5cGUATm8gZXJyb3IgaW5mb3JtYXRpb24AAAAAAAAFAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAwAAAGgmAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAD//////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAABQAAABggAAAABAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAK/////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQGwAAYBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABVc2FnZTogJXMgLWVuY29kZXwtZGVjb2RlIFstaSBpbnB1dF9maWxlXSBbLW8gb3V0cHV0X2ZpbGVdIFstaF0gWy12XQoALWgALXYALWVuY29kZQAtZGVjb2RlAC1pAC1vAEVycm9yOiBNaXNzaW5nIGFyZyBhZnRlciAlcwoARXJyb3I6IGludmFsaWQgZmxhZyAlcwoARXJyb3I6IC1lbmNvZGV8LWRlY29kZSByZXF1aXJlZAoATFpGU0UgZW5jb2RlCgBMWkZTRSBkZWNvZGUKAHN0ZGluAElucHV0OiAlcwoAc3Rkb3V0AE91dHB1dDogJXMKAEZpbGUgaXMgdG9vIGxhcmdlCgBtYWxsb2MAcmVhZABJbnB1dCBzaXplOiAlenUgQgoAT3V0cHV0IGJ1ZmZlciB3YXMgdG9vIHNtYWxsLCBpbmNyZWFzaW5nIHNpemUuLi4KAE91dHB1dCBzaXplOiAlenUgQgoAQ29tcHJlc3Npb24gcmF0aW86ICUuM2YKAFNwZWVkOiAlLjJmIG5zL0IsICUuMmYgTUIvcwoAd3JpdGUARmFpbGVkIHRvIHdyaXRlIHRvIG91dHB1dCBmaWxlCgBnZXR0aW1lb2ZkYXkALSsgICAwWDB4AChudWxsKQAtMFgrMFggMFgtMHgrMHggMHgAaW5mAElORgBuYW4ATkFOAC4AL3Byb2Mvc2VsZi9mZC8=";





/* no memory initializer */
var tempDoublePtr = 10048
assert(tempDoublePtr % 8 == 0);

function copyTempFloat(ptr) { // functions, because inlining this code increases code size too much
  HEAP8[tempDoublePtr] = HEAP8[ptr];
  HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];
  HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];
  HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];
}

function copyTempDouble(ptr) {
  HEAP8[tempDoublePtr] = HEAP8[ptr];
  HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];
  HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];
  HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];
  HEAP8[tempDoublePtr+4] = HEAP8[ptr+4];
  HEAP8[tempDoublePtr+5] = HEAP8[ptr+5];
  HEAP8[tempDoublePtr+6] = HEAP8[ptr+6];
  HEAP8[tempDoublePtr+7] = HEAP8[ptr+7];
}

// {{PRE_LIBRARY}}


  function demangle(func) {
      warnOnce('warning: build with  -s DEMANGLE_SUPPORT=1  to link in libcxxabi demangling');
      return func;
    }

  function demangleAll(text) {
      var regex =
        /\b__Z[\w\d_]+/g;
      return text.replace(regex,
        function(x) {
          var y = demangle(x);
          return x === y ? x : (y + ' [' + x + ']');
        });
    }

  function jsStackTrace() {
      var err = new Error();
      if (!err.stack) {
        // IE10+ special cases: It does have callstack info, but it is only populated if an Error object is thrown,
        // so try that as a special-case.
        try {
          throw new Error(0);
        } catch(e) {
          err = e;
        }
        if (!err.stack) {
          return '(no stack trace available)';
        }
      }
      return err.stack.toString();
    }

  function stackTrace() {
      var js = jsStackTrace();
      if (Module['extraStackTrace']) js += '\n' + Module['extraStackTrace']();
      return demangleAll(js);
    }

  function ___lock() {}

  
    

  
  
  var PATH={splitPath:function(filename) {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
      },normalizeArray:function(parts, allowAboveRoot) {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
          var last = parts[i];
          if (last === '.') {
            parts.splice(i, 1);
          } else if (last === '..') {
            parts.splice(i, 1);
            up++;
          } else if (up) {
            parts.splice(i, 1);
            up--;
          }
        }
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
          for (; up; up--) {
            parts.unshift('..');
          }
        }
        return parts;
      },normalize:function(path) {
        var isAbsolute = path.charAt(0) === '/',
            trailingSlash = path.substr(-1) === '/';
        // Normalize the path
        path = PATH.normalizeArray(path.split('/').filter(function(p) {
          return !!p;
        }), !isAbsolute).join('/');
        if (!path && !isAbsolute) {
          path = '.';
        }
        if (path && trailingSlash) {
          path += '/';
        }
        return (isAbsolute ? '/' : '') + path;
      },dirname:function(path) {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) {
          // No dirname whatsoever
          return '.';
        }
        if (dir) {
          // It has a dirname, strip trailing slash
          dir = dir.substr(0, dir.length - 1);
        }
        return root + dir;
      },basename:function(path) {
        // EMSCRIPTEN return '/'' for '/', not an empty string
        if (path === '/') return '/';
        var lastSlash = path.lastIndexOf('/');
        if (lastSlash === -1) return path;
        return path.substr(lastSlash+1);
      },extname:function(path) {
        return PATH.splitPath(path)[3];
      },join:function() {
        var paths = Array.prototype.slice.call(arguments, 0);
        return PATH.normalize(paths.join('/'));
      },join2:function(l, r) {
        return PATH.normalize(l + '/' + r);
      }};
  
  
  function ___setErrNo(value) {
      if (Module['___errno_location']) HEAP32[((Module['___errno_location']())>>2)]=value;
      else err('failed to set errno from JS');
      return value;
    }
  
  var PATH_FS={resolve:function() {
        var resolvedPath = '',
          resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
          var path = (i >= 0) ? arguments[i] : FS.cwd();
          // Skip empty and invalid entries
          if (typeof path !== 'string') {
            throw new TypeError('Arguments to path.resolve must be strings');
          } else if (!path) {
            return ''; // an invalid portion invalidates the whole thing
          }
          resolvedPath = path + '/' + resolvedPath;
          resolvedAbsolute = path.charAt(0) === '/';
        }
        // At this point the path should be resolved to a full absolute path, but
        // handle relative paths to be safe (might happen when process.cwd() fails)
        resolvedPath = PATH.normalizeArray(resolvedPath.split('/').filter(function(p) {
          return !!p;
        }), !resolvedAbsolute).join('/');
        return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
      },relative:function(from, to) {
        from = PATH_FS.resolve(from).substr(1);
        to = PATH_FS.resolve(to).substr(1);
        function trim(arr) {
          var start = 0;
          for (; start < arr.length; start++) {
            if (arr[start] !== '') break;
          }
          var end = arr.length - 1;
          for (; end >= 0; end--) {
            if (arr[end] !== '') break;
          }
          if (start > end) return [];
          return arr.slice(start, end - start + 1);
        }
        var fromParts = trim(from.split('/'));
        var toParts = trim(to.split('/'));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
          if (fromParts[i] !== toParts[i]) {
            samePartsLength = i;
            break;
          }
        }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
          outputParts.push('..');
        }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join('/');
      }};
  
  var TTY={ttys:[],init:function () {
        // https://github.com/emscripten-core/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // currently, FS.init does not distinguish if process.stdin is a file or TTY
        //   // device, it always assumes it's a TTY device. because of this, we're forcing
        //   // process.stdin to UTF8 encoding to at least make stdin reading compatible
        //   // with text files until FS.init can be refactored.
        //   process['stdin']['setEncoding']('utf8');
        // }
      },shutdown:function() {
        // https://github.com/emscripten-core/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // inolen: any idea as to why node -e 'process.stdin.read()' wouldn't exit immediately (with process.stdin being a tty)?
        //   // isaacs: because now it's reading from the stream, you've expressed interest in it, so that read() kicks off a _read() which creates a ReadReq operation
        //   // inolen: I thought read() in that case was a synchronous operation that just grabbed some amount of buffered data if it exists?
        //   // isaacs: it is. but it also triggers a _read() call, which calls readStart() on the handle
        //   // isaacs: do process.stdin.pause() and i'd think it'd probably close the pending call
        //   process['stdin']['pause']();
        // }
      },register:function(dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops: ops };
        FS.registerDevice(dev, TTY.stream_ops);
      },stream_ops:{open:function(stream) {
          var tty = TTY.ttys[stream.node.rdev];
          if (!tty) {
            throw new FS.ErrnoError(19);
          }
          stream.tty = tty;
          stream.seekable = false;
        },close:function(stream) {
          // flush any pending line data
          stream.tty.ops.flush(stream.tty);
        },flush:function(stream) {
          stream.tty.ops.flush(stream.tty);
        },read:function(stream, buffer, offset, length, pos /* ignored */) {
          if (!stream.tty || !stream.tty.ops.get_char) {
            throw new FS.ErrnoError(6);
          }
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = stream.tty.ops.get_char(stream.tty);
            } catch (e) {
              throw new FS.ErrnoError(5);
            }
            if (result === undefined && bytesRead === 0) {
              throw new FS.ErrnoError(11);
            }
            if (result === null || result === undefined) break;
            bytesRead++;
            buffer[offset+i] = result;
          }
          if (bytesRead) {
            stream.node.timestamp = Date.now();
          }
          return bytesRead;
        },write:function(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.put_char) {
            throw new FS.ErrnoError(6);
          }
          try {
            for (var i = 0; i < length; i++) {
              stream.tty.ops.put_char(stream.tty, buffer[offset+i]);
            }
          } catch (e) {
            throw new FS.ErrnoError(5);
          }
          if (length) {
            stream.node.timestamp = Date.now();
          }
          return i;
        }},default_tty_ops:{get_char:function(tty) {
          if (!tty.input.length) {
            var result = null;
            if (ENVIRONMENT_IS_NODE) {
              // we will read data by chunks of BUFSIZE
              var BUFSIZE = 256;
              var buf = Buffer.alloc ? Buffer.alloc(BUFSIZE) : new Buffer(BUFSIZE);
              var bytesRead = 0;
  
              var isPosixPlatform = (process.platform != 'win32'); // Node doesn't offer a direct check, so test by exclusion
  
              var fd = process.stdin.fd;
              if (isPosixPlatform) {
                // Linux and Mac cannot use process.stdin.fd (which isn't set up as sync)
                var usingDevice = false;
                try {
                  fd = fs.openSync('/dev/stdin', 'r');
                  usingDevice = true;
                } catch (e) {}
              }
  
              try {
                bytesRead = fs.readSync(fd, buf, 0, BUFSIZE, null);
              } catch(e) {
                // Cross-platform differences: on Windows, reading EOF throws an exception, but on other OSes,
                // reading EOF returns 0. Uniformize behavior by treating the EOF exception to return 0.
                if (e.toString().indexOf('EOF') != -1) bytesRead = 0;
                else throw e;
              }
  
              if (usingDevice) { fs.closeSync(fd); }
              if (bytesRead > 0) {
                result = buf.slice(0, bytesRead).toString('utf-8');
              } else {
                result = null;
              }
            } else
            if (typeof window != 'undefined' &&
              typeof window.prompt == 'function') {
              // Browser.
              result = window.prompt('Input: ');  // returns null on cancel
              if (result !== null) {
                result += '\n';
              }
            } else if (typeof readline == 'function') {
              // Command line.
              result = readline();
              if (result !== null) {
                result += '\n';
              }
            }
            if (!result) {
              return null;
            }
            tty.input = intArrayFromString(result, true);
          }
          return tty.input.shift();
        },put_char:function(tty, val) {
          if (val === null || val === 10) {
            out(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val); // val == 0 would cut text output off in the middle.
          }
        },flush:function(tty) {
          if (tty.output && tty.output.length > 0) {
            out(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          }
        }},default_tty1_ops:{put_char:function(tty, val) {
          if (val === null || val === 10) {
            err(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        },flush:function(tty) {
          if (tty.output && tty.output.length > 0) {
            err(UTF8ArrayToString(tty.output, 0));
            tty.output = [];
          }
        }}};
  
  var MEMFS={ops_table:null,mount:function(mount) {
        return MEMFS.createNode(null, '/', 16384 | 511 /* 0777 */, 0);
      },createNode:function(parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
          // no supported
          throw new FS.ErrnoError(1);
        }
        if (!MEMFS.ops_table) {
          MEMFS.ops_table = {
            dir: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr,
                lookup: MEMFS.node_ops.lookup,
                mknod: MEMFS.node_ops.mknod,
                rename: MEMFS.node_ops.rename,
                unlink: MEMFS.node_ops.unlink,
                rmdir: MEMFS.node_ops.rmdir,
                readdir: MEMFS.node_ops.readdir,
                symlink: MEMFS.node_ops.symlink
              },
              stream: {
                llseek: MEMFS.stream_ops.llseek
              }
            },
            file: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr
              },
              stream: {
                llseek: MEMFS.stream_ops.llseek,
                read: MEMFS.stream_ops.read,
                write: MEMFS.stream_ops.write,
                allocate: MEMFS.stream_ops.allocate,
                mmap: MEMFS.stream_ops.mmap,
                msync: MEMFS.stream_ops.msync
              }
            },
            link: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr,
                readlink: MEMFS.node_ops.readlink
              },
              stream: {}
            },
            chrdev: {
              node: {
                getattr: MEMFS.node_ops.getattr,
                setattr: MEMFS.node_ops.setattr
              },
              stream: FS.chrdev_stream_ops
            }
          };
        }
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
          node.node_ops = MEMFS.ops_table.dir.node;
          node.stream_ops = MEMFS.ops_table.dir.stream;
          node.contents = {};
        } else if (FS.isFile(node.mode)) {
          node.node_ops = MEMFS.ops_table.file.node;
          node.stream_ops = MEMFS.ops_table.file.stream;
          node.usedBytes = 0; // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
          // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
          // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
          // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
          node.contents = null; 
        } else if (FS.isLink(node.mode)) {
          node.node_ops = MEMFS.ops_table.link.node;
          node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
          node.node_ops = MEMFS.ops_table.chrdev.node;
          node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.timestamp = Date.now();
        // add the new node to the parent
        if (parent) {
          parent.contents[name] = node;
        }
        return node;
      },getFileDataAsRegularArray:function(node) {
        if (node.contents && node.contents.subarray) {
          var arr = [];
          for (var i = 0; i < node.usedBytes; ++i) arr.push(node.contents[i]);
          return arr; // Returns a copy of the original data.
        }
        return node.contents; // No-op, the file contents are already in a JS array. Return as-is.
      },getFileDataAsTypedArray:function(node) {
        if (!node.contents) return new Uint8Array;
        if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes); // Make sure to not return excess unused bytes.
        return new Uint8Array(node.contents);
      },expandFileStorage:function(node, newCapacity) {
        var prevCapacity = node.contents ? node.contents.length : 0;
        if (prevCapacity >= newCapacity) return; // No need to expand, the storage was already large enough.
        // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
        // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
        // avoid overshooting the allocation cap by a very large margin.
        var CAPACITY_DOUBLING_MAX = 1024 * 1024;
        newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2.0 : 1.125)) | 0);
        if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256); // At minimum allocate 256b for each file when expanding.
        var oldContents = node.contents;
        node.contents = new Uint8Array(newCapacity); // Allocate new storage.
        if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0); // Copy old data over to the new storage.
        return;
      },resizeFileStorage:function(node, newSize) {
        if (node.usedBytes == newSize) return;
        if (newSize == 0) {
          node.contents = null; // Fully decommit when requesting a resize to zero.
          node.usedBytes = 0;
          return;
        }
        if (!node.contents || node.contents.subarray) { // Resize a typed array if that is being used as the backing store.
          var oldContents = node.contents;
          node.contents = new Uint8Array(new ArrayBuffer(newSize)); // Allocate new storage.
          if (oldContents) {
            node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes))); // Copy old data over to the new storage.
          }
          node.usedBytes = newSize;
          return;
        }
        // Backing with a JS array.
        if (!node.contents) node.contents = [];
        if (node.contents.length > newSize) node.contents.length = newSize;
        else while (node.contents.length < newSize) node.contents.push(0);
        node.usedBytes = newSize;
      },node_ops:{getattr:function(node) {
          var attr = {};
          // device numbers reuse inode numbers.
          attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
          attr.ino = node.id;
          attr.mode = node.mode;
          attr.nlink = 1;
          attr.uid = 0;
          attr.gid = 0;
          attr.rdev = node.rdev;
          if (FS.isDir(node.mode)) {
            attr.size = 4096;
          } else if (FS.isFile(node.mode)) {
            attr.size = node.usedBytes;
          } else if (FS.isLink(node.mode)) {
            attr.size = node.link.length;
          } else {
            attr.size = 0;
          }
          attr.atime = new Date(node.timestamp);
          attr.mtime = new Date(node.timestamp);
          attr.ctime = new Date(node.timestamp);
          // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
          //       but this is not required by the standard.
          attr.blksize = 4096;
          attr.blocks = Math.ceil(attr.size / attr.blksize);
          return attr;
        },setattr:function(node, attr) {
          if (attr.mode !== undefined) {
            node.mode = attr.mode;
          }
          if (attr.timestamp !== undefined) {
            node.timestamp = attr.timestamp;
          }
          if (attr.size !== undefined) {
            MEMFS.resizeFileStorage(node, attr.size);
          }
        },lookup:function(parent, name) {
          throw FS.genericErrors[2];
        },mknod:function(parent, name, mode, dev) {
          return MEMFS.createNode(parent, name, mode, dev);
        },rename:function(old_node, new_dir, new_name) {
          // if we're overwriting a directory at new_name, make sure it's empty.
          if (FS.isDir(old_node.mode)) {
            var new_node;
            try {
              new_node = FS.lookupNode(new_dir, new_name);
            } catch (e) {
            }
            if (new_node) {
              for (var i in new_node.contents) {
                throw new FS.ErrnoError(39);
              }
            }
          }
          // do the internal rewiring
          delete old_node.parent.contents[old_node.name];
          old_node.name = new_name;
          new_dir.contents[new_name] = old_node;
          old_node.parent = new_dir;
        },unlink:function(parent, name) {
          delete parent.contents[name];
        },rmdir:function(parent, name) {
          var node = FS.lookupNode(parent, name);
          for (var i in node.contents) {
            throw new FS.ErrnoError(39);
          }
          delete parent.contents[name];
        },readdir:function(node) {
          var entries = ['.', '..'];
          for (var key in node.contents) {
            if (!node.contents.hasOwnProperty(key)) {
              continue;
            }
            entries.push(key);
          }
          return entries;
        },symlink:function(parent, newname, oldpath) {
          var node = MEMFS.createNode(parent, newname, 511 /* 0777 */ | 40960, 0);
          node.link = oldpath;
          return node;
        },readlink:function(node) {
          if (!FS.isLink(node.mode)) {
            throw new FS.ErrnoError(22);
          }
          return node.link;
        }},stream_ops:{read:function(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= stream.node.usedBytes) return 0;
          var size = Math.min(stream.node.usedBytes - position, length);
          assert(size >= 0);
          if (size > 8 && contents.subarray) { // non-trivial, and typed array
            buffer.set(contents.subarray(position, position + size), offset);
          } else {
            for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
          }
          return size;
        },write:function(stream, buffer, offset, length, position, canOwn) {
  
          if (!length) return 0;
          var node = stream.node;
          node.timestamp = Date.now();
  
          if (buffer.subarray && (!node.contents || node.contents.subarray)) { // This write is from a typed array to a typed array?
            if (canOwn) {
              assert(position === 0, 'canOwn must imply no weird position inside the file');
              node.contents = buffer.subarray(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (node.usedBytes === 0 && position === 0) { // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
              node.contents = new Uint8Array(buffer.subarray(offset, offset + length));
              node.usedBytes = length;
              return length;
            } else if (position + length <= node.usedBytes) { // Writing to an already allocated and used subrange of the file?
              node.contents.set(buffer.subarray(offset, offset + length), position);
              return length;
            }
          }
  
          // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
          MEMFS.expandFileStorage(node, position+length);
          if (node.contents.subarray && buffer.subarray) node.contents.set(buffer.subarray(offset, offset + length), position); // Use typed array write if available.
          else {
            for (var i = 0; i < length; i++) {
             node.contents[position + i] = buffer[offset + i]; // Or fall back to manual write if not.
            }
          }
          node.usedBytes = Math.max(node.usedBytes, position+length);
          return length;
        },llseek:function(stream, offset, whence) {
          var position = offset;
          if (whence === 1) {  // SEEK_CUR.
            position += stream.position;
          } else if (whence === 2) {  // SEEK_END.
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.usedBytes;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(22);
          }
          return position;
        },allocate:function(stream, offset, length) {
          MEMFS.expandFileStorage(stream.node, offset + length);
          stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length);
        },mmap:function(stream, buffer, offset, length, position, prot, flags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(19);
          }
          var ptr;
          var allocated;
          var contents = stream.node.contents;
          // Only make a new copy when MAP_PRIVATE is specified.
          if ( !(flags & 2) &&
                (contents.buffer === buffer || contents.buffer === buffer.buffer) ) {
            // We can't emulate MAP_SHARED when the file is not backed by the buffer
            // we're mapping to (e.g. the HEAP buffer).
            allocated = false;
            ptr = contents.byteOffset;
          } else {
            // Try to avoid unnecessary slices.
            if (position > 0 || position + length < stream.node.usedBytes) {
              if (contents.subarray) {
                contents = contents.subarray(position, position + length);
              } else {
                contents = Array.prototype.slice.call(contents, position, position + length);
              }
            }
            allocated = true;
            // malloc() can lead to growing the heap. If targeting the heap, we need to
            // re-acquire the heap buffer object in case growth had occurred.
            var fromHeap = (buffer.buffer == HEAP8.buffer);
            ptr = _malloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(12);
            }
            (fromHeap ? HEAP8 : buffer).set(contents, ptr);
          }
          return { ptr: ptr, allocated: allocated };
        },msync:function(stream, buffer, offset, length, mmapFlags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(19);
          }
          if (mmapFlags & 2) {
            // MAP_PRIVATE calls need not to be synced back to underlying fs
            return 0;
          }
  
          var bytesWritten = MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
          // should we check if bytesWritten and length are the same?
          return 0;
        }}};
  
  var IDBFS={dbs:{},indexedDB:function() {
        if (typeof indexedDB !== 'undefined') return indexedDB;
        var ret = null;
        if (typeof window === 'object') ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
        assert(ret, 'IDBFS used, but indexedDB not supported');
        return ret;
      },DB_VERSION:21,DB_STORE_NAME:"FILE_DATA",mount:function(mount) {
        // reuse all of the core MEMFS functionality
        return MEMFS.mount.apply(null, arguments);
      },syncfs:function(mount, populate, callback) {
        IDBFS.getLocalSet(mount, function(err, local) {
          if (err) return callback(err);
  
          IDBFS.getRemoteSet(mount, function(err, remote) {
            if (err) return callback(err);
  
            var src = populate ? remote : local;
            var dst = populate ? local : remote;
  
            IDBFS.reconcile(src, dst, callback);
          });
        });
      },getDB:function(name, callback) {
        // check the cache first
        var db = IDBFS.dbs[name];
        if (db) {
          return callback(null, db);
        }
  
        var req;
        try {
          req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);
        } catch (e) {
          return callback(e);
        }
        if (!req) {
          return callback("Unable to connect to IndexedDB");
        }
        req.onupgradeneeded = function(e) {
          var db = e.target.result;
          var transaction = e.target.transaction;
  
          var fileStore;
  
          if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
            fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME);
          } else {
            fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME);
          }
  
          if (!fileStore.indexNames.contains('timestamp')) {
            fileStore.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = function() {
          db = req.result;
  
          // add to the cache
          IDBFS.dbs[name] = db;
          callback(null, db);
        };
        req.onerror = function(e) {
          callback(this.error);
          e.preventDefault();
        };
      },getLocalSet:function(mount, callback) {
        var entries = {};
  
        function isRealDir(p) {
          return p !== '.' && p !== '..';
        };
        function toAbsolute(root) {
          return function(p) {
            return PATH.join2(root, p);
          }
        };
  
        var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
  
        while (check.length) {
          var path = check.pop();
          var stat;
  
          try {
            stat = FS.stat(path);
          } catch (e) {
            return callback(e);
          }
  
          if (FS.isDir(stat.mode)) {
            check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
          }
  
          entries[path] = { timestamp: stat.mtime };
        }
  
        return callback(null, { type: 'local', entries: entries });
      },getRemoteSet:function(mount, callback) {
        var entries = {};
  
        IDBFS.getDB(mount.mountpoint, function(err, db) {
          if (err) return callback(err);
  
          try {
            var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readonly');
            transaction.onerror = function(e) {
              callback(this.error);
              e.preventDefault();
            };
  
            var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
            var index = store.index('timestamp');
  
            index.openKeyCursor().onsuccess = function(event) {
              var cursor = event.target.result;
  
              if (!cursor) {
                return callback(null, { type: 'remote', db: db, entries: entries });
              }
  
              entries[cursor.primaryKey] = { timestamp: cursor.key };
  
              cursor.continue();
            };
          } catch (e) {
            return callback(e);
          }
        });
      },loadLocalEntry:function(path, callback) {
        var stat, node;
  
        try {
          var lookup = FS.lookupPath(path);
          node = lookup.node;
          stat = FS.stat(path);
        } catch (e) {
          return callback(e);
        }
  
        if (FS.isDir(stat.mode)) {
          return callback(null, { timestamp: stat.mtime, mode: stat.mode });
        } else if (FS.isFile(stat.mode)) {
          // Performance consideration: storing a normal JavaScript array to a IndexedDB is much slower than storing a typed array.
          // Therefore always convert the file contents to a typed array first before writing the data to IndexedDB.
          node.contents = MEMFS.getFileDataAsTypedArray(node);
          return callback(null, { timestamp: stat.mtime, mode: stat.mode, contents: node.contents });
        } else {
          return callback(new Error('node type not supported'));
        }
      },storeLocalEntry:function(path, entry, callback) {
        try {
          if (FS.isDir(entry.mode)) {
            FS.mkdir(path, entry.mode);
          } else if (FS.isFile(entry.mode)) {
            FS.writeFile(path, entry.contents, { canOwn: true });
          } else {
            return callback(new Error('node type not supported'));
          }
  
          FS.chmod(path, entry.mode);
          FS.utime(path, entry.timestamp, entry.timestamp);
        } catch (e) {
          return callback(e);
        }
  
        callback(null);
      },removeLocalEntry:function(path, callback) {
        try {
          var lookup = FS.lookupPath(path);
          var stat = FS.stat(path);
  
          if (FS.isDir(stat.mode)) {
            FS.rmdir(path);
          } else if (FS.isFile(stat.mode)) {
            FS.unlink(path);
          }
        } catch (e) {
          return callback(e);
        }
  
        callback(null);
      },loadRemoteEntry:function(store, path, callback) {
        var req = store.get(path);
        req.onsuccess = function(event) { callback(null, event.target.result); };
        req.onerror = function(e) {
          callback(this.error);
          e.preventDefault();
        };
      },storeRemoteEntry:function(store, path, entry, callback) {
        var req = store.put(entry, path);
        req.onsuccess = function() { callback(null); };
        req.onerror = function(e) {
          callback(this.error);
          e.preventDefault();
        };
      },removeRemoteEntry:function(store, path, callback) {
        var req = store.delete(path);
        req.onsuccess = function() { callback(null); };
        req.onerror = function(e) {
          callback(this.error);
          e.preventDefault();
        };
      },reconcile:function(src, dst, callback) {
        var total = 0;
  
        var create = [];
        Object.keys(src.entries).forEach(function (key) {
          var e = src.entries[key];
          var e2 = dst.entries[key];
          if (!e2 || e.timestamp > e2.timestamp) {
            create.push(key);
            total++;
          }
        });
  
        var remove = [];
        Object.keys(dst.entries).forEach(function (key) {
          var e = dst.entries[key];
          var e2 = src.entries[key];
          if (!e2) {
            remove.push(key);
            total++;
          }
        });
  
        if (!total) {
          return callback(null);
        }
  
        var errored = false;
        var db = src.type === 'remote' ? src.db : dst.db;
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readwrite');
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
  
        function done(err) {
          if (err && !errored) {
            errored = true;
            return callback(err);
          }
        };
  
        transaction.onerror = function(e) {
          done(this.error);
          e.preventDefault();
        };
  
        transaction.oncomplete = function(e) {
          if (!errored) {
            callback(null);
          }
        };
  
        // sort paths in ascending order so directory entries are created
        // before the files inside them
        create.sort().forEach(function (path) {
          if (dst.type === 'local') {
            IDBFS.loadRemoteEntry(store, path, function (err, entry) {
              if (err) return done(err);
              IDBFS.storeLocalEntry(path, entry, done);
            });
          } else {
            IDBFS.loadLocalEntry(path, function (err, entry) {
              if (err) return done(err);
              IDBFS.storeRemoteEntry(store, path, entry, done);
            });
          }
        });
  
        // sort paths in descending order so files are deleted before their
        // parent directories
        remove.sort().reverse().forEach(function(path) {
          if (dst.type === 'local') {
            IDBFS.removeLocalEntry(path, done);
          } else {
            IDBFS.removeRemoteEntry(store, path, done);
          }
        });
      }};
  
  var NODEFS={isWindows:false,staticInit:function() {
        NODEFS.isWindows = !!process.platform.match(/^win/);
        var flags = process["binding"]("constants");
        // Node.js 4 compatibility: it has no namespaces for constants
        if (flags["fs"]) {
          flags = flags["fs"];
        }
        NODEFS.flagsForNodeMap = {
          "1024": flags["O_APPEND"],
          "64": flags["O_CREAT"],
          "128": flags["O_EXCL"],
          "0": flags["O_RDONLY"],
          "2": flags["O_RDWR"],
          "4096": flags["O_SYNC"],
          "512": flags["O_TRUNC"],
          "1": flags["O_WRONLY"]
        };
      },bufferFrom:function (arrayBuffer) {
        // Node.js < 4.5 compatibility: Buffer.from does not support ArrayBuffer
        // Buffer.from before 4.5 was just a method inherited from Uint8Array
        // Buffer.alloc has been added with Buffer.from together, so check it instead
        return Buffer["alloc"] ? Buffer.from(arrayBuffer) : new Buffer(arrayBuffer);
      },mount:function (mount) {
        assert(ENVIRONMENT_HAS_NODE);
        return NODEFS.createNode(null, '/', NODEFS.getMode(mount.opts.root), 0);
      },createNode:function (parent, name, mode, dev) {
        if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
          throw new FS.ErrnoError(22);
        }
        var node = FS.createNode(parent, name, mode);
        node.node_ops = NODEFS.node_ops;
        node.stream_ops = NODEFS.stream_ops;
        return node;
      },getMode:function (path) {
        var stat;
        try {
          stat = fs.lstatSync(path);
          if (NODEFS.isWindows) {
            // Node.js on Windows never represents permission bit 'x', so
            // propagate read bits to execute bits
            stat.mode = stat.mode | ((stat.mode & 292) >> 2);
          }
        } catch (e) {
          if (!e.code) throw e;
          throw new FS.ErrnoError(-e.errno); // syscall errnos are negated, node's are not
        }
        return stat.mode;
      },realPath:function (node) {
        var parts = [];
        while (node.parent !== node) {
          parts.push(node.name);
          node = node.parent;
        }
        parts.push(node.mount.opts.root);
        parts.reverse();
        return PATH.join.apply(null, parts);
      },flagsForNode:function(flags) {
        flags &= ~0x200000 /*O_PATH*/; // Ignore this flag from musl, otherwise node.js fails to open the file.
        flags &= ~0x800 /*O_NONBLOCK*/; // Ignore this flag from musl, otherwise node.js fails to open the file.
        flags &= ~0x8000 /*O_LARGEFILE*/; // Ignore this flag from musl, otherwise node.js fails to open the file.
        flags &= ~0x80000 /*O_CLOEXEC*/; // Some applications may pass it; it makes no sense for a single process.
        var newFlags = 0;
        for (var k in NODEFS.flagsForNodeMap) {
          if (flags & k) {
            newFlags |= NODEFS.flagsForNodeMap[k];
            flags ^= k;
          }
        }
  
        if (!flags) {
          return newFlags;
        } else {
          throw new FS.ErrnoError(22);
        }
      },node_ops:{getattr:function(node) {
          var path = NODEFS.realPath(node);
          var stat;
          try {
            stat = fs.lstatSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
          // node.js v0.10.20 doesn't report blksize and blocks on Windows. Fake them with default blksize of 4096.
          // See http://support.microsoft.com/kb/140365
          if (NODEFS.isWindows && !stat.blksize) {
            stat.blksize = 4096;
          }
          if (NODEFS.isWindows && !stat.blocks) {
            stat.blocks = (stat.size+stat.blksize-1)/stat.blksize|0;
          }
          return {
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            nlink: stat.nlink,
            uid: stat.uid,
            gid: stat.gid,
            rdev: stat.rdev,
            size: stat.size,
            atime: stat.atime,
            mtime: stat.mtime,
            ctime: stat.ctime,
            blksize: stat.blksize,
            blocks: stat.blocks
          };
        },setattr:function(node, attr) {
          var path = NODEFS.realPath(node);
          try {
            if (attr.mode !== undefined) {
              fs.chmodSync(path, attr.mode);
              // update the common node structure mode as well
              node.mode = attr.mode;
            }
            if (attr.timestamp !== undefined) {
              var date = new Date(attr.timestamp);
              fs.utimesSync(path, date, date);
            }
            if (attr.size !== undefined) {
              fs.truncateSync(path, attr.size);
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },lookup:function (parent, name) {
          var path = PATH.join2(NODEFS.realPath(parent), name);
          var mode = NODEFS.getMode(path);
          return NODEFS.createNode(parent, name, mode);
        },mknod:function (parent, name, mode, dev) {
          var node = NODEFS.createNode(parent, name, mode, dev);
          // create the backing node for this in the fs root as well
          var path = NODEFS.realPath(node);
          try {
            if (FS.isDir(node.mode)) {
              fs.mkdirSync(path, node.mode);
            } else {
              fs.writeFileSync(path, '', { mode: node.mode });
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
          return node;
        },rename:function (oldNode, newDir, newName) {
          var oldPath = NODEFS.realPath(oldNode);
          var newPath = PATH.join2(NODEFS.realPath(newDir), newName);
          try {
            fs.renameSync(oldPath, newPath);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },unlink:function(parent, name) {
          var path = PATH.join2(NODEFS.realPath(parent), name);
          try {
            fs.unlinkSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },rmdir:function(parent, name) {
          var path = PATH.join2(NODEFS.realPath(parent), name);
          try {
            fs.rmdirSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },readdir:function(node) {
          var path = NODEFS.realPath(node);
          try {
            return fs.readdirSync(path);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },symlink:function(parent, newName, oldPath) {
          var newPath = PATH.join2(NODEFS.realPath(parent), newName);
          try {
            fs.symlinkSync(oldPath, newPath);
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },readlink:function(node) {
          var path = NODEFS.realPath(node);
          try {
            path = fs.readlinkSync(path);
            path = NODEJS_PATH.relative(NODEJS_PATH.resolve(node.mount.opts.root), path);
            return path;
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        }},stream_ops:{open:function (stream) {
          var path = NODEFS.realPath(stream.node);
          try {
            if (FS.isFile(stream.node.mode)) {
              stream.nfd = fs.openSync(path, NODEFS.flagsForNode(stream.flags));
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },close:function (stream) {
          try {
            if (FS.isFile(stream.node.mode) && stream.nfd) {
              fs.closeSync(stream.nfd);
            }
          } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(-e.errno);
          }
        },read:function (stream, buffer, offset, length, position) {
          // Node.js < 6 compatibility: node errors on 0 length reads
          if (length === 0) return 0;
          try {
            return fs.readSync(stream.nfd, NODEFS.bufferFrom(buffer.buffer), offset, length, position);
          } catch (e) {
            throw new FS.ErrnoError(-e.errno);
          }
        },write:function (stream, buffer, offset, length, position) {
          try {
            return fs.writeSync(stream.nfd, NODEFS.bufferFrom(buffer.buffer), offset, length, position);
          } catch (e) {
            throw new FS.ErrnoError(-e.errno);
          }
        },llseek:function (stream, offset, whence) {
          var position = offset;
          if (whence === 1) {  // SEEK_CUR.
            position += stream.position;
          } else if (whence === 2) {  // SEEK_END.
            if (FS.isFile(stream.node.mode)) {
              try {
                var stat = fs.fstatSync(stream.nfd);
                position += stat.size;
              } catch (e) {
                throw new FS.ErrnoError(-e.errno);
              }
            }
          }
  
          if (position < 0) {
            throw new FS.ErrnoError(22);
          }
  
          return position;
        }}};
  
  var WORKERFS={DIR_MODE:16895,FILE_MODE:33279,reader:null,mount:function (mount) {
        assert(ENVIRONMENT_IS_WORKER);
        if (!WORKERFS.reader) WORKERFS.reader = new FileReaderSync();
        var root = WORKERFS.createNode(null, '/', WORKERFS.DIR_MODE, 0);
        var createdParents = {};
        function ensureParent(path) {
          // return the parent node, creating subdirs as necessary
          var parts = path.split('/');
          var parent = root;
          for (var i = 0; i < parts.length-1; i++) {
            var curr = parts.slice(0, i+1).join('/');
            // Issue 4254: Using curr as a node name will prevent the node
            // from being found in FS.nameTable when FS.open is called on
            // a path which holds a child of this node,
            // given that all FS functions assume node names
            // are just their corresponding parts within their given path,
            // rather than incremental aggregates which include their parent's
            // directories.
            if (!createdParents[curr]) {
              createdParents[curr] = WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0);
            }
            parent = createdParents[curr];
          }
          return parent;
        }
        function base(path) {
          var parts = path.split('/');
          return parts[parts.length-1];
        }
        // We also accept FileList here, by using Array.prototype
        Array.prototype.forEach.call(mount.opts["files"] || [], function(file) {
          WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
        });
        (mount.opts["blobs"] || []).forEach(function(obj) {
          WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"]);
        });
        (mount.opts["packages"] || []).forEach(function(pack) {
          pack['metadata'].files.forEach(function(file) {
            var name = file.filename.substr(1); // remove initial slash
            WORKERFS.createNode(ensureParent(name), base(name), WORKERFS.FILE_MODE, 0, pack['blob'].slice(file.start, file.end));
          });
        });
        return root;
      },createNode:function (parent, name, mode, dev, contents, mtime) {
        var node = FS.createNode(parent, name, mode);
        node.mode = mode;
        node.node_ops = WORKERFS.node_ops;
        node.stream_ops = WORKERFS.stream_ops;
        node.timestamp = (mtime || new Date).getTime();
        assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
        if (mode === WORKERFS.FILE_MODE) {
          node.size = contents.size;
          node.contents = contents;
        } else {
          node.size = 4096;
          node.contents = {};
        }
        if (parent) {
          parent.contents[name] = node;
        }
        return node;
      },node_ops:{getattr:function(node) {
          return {
            dev: 1,
            ino: undefined,
            mode: node.mode,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: undefined,
            size: node.size,
            atime: new Date(node.timestamp),
            mtime: new Date(node.timestamp),
            ctime: new Date(node.timestamp),
            blksize: 4096,
            blocks: Math.ceil(node.size / 4096),
          };
        },setattr:function(node, attr) {
          if (attr.mode !== undefined) {
            node.mode = attr.mode;
          }
          if (attr.timestamp !== undefined) {
            node.timestamp = attr.timestamp;
          }
        },lookup:function(parent, name) {
          throw new FS.ErrnoError(2);
        },mknod:function (parent, name, mode, dev) {
          throw new FS.ErrnoError(1);
        },rename:function (oldNode, newDir, newName) {
          throw new FS.ErrnoError(1);
        },unlink:function(parent, name) {
          throw new FS.ErrnoError(1);
        },rmdir:function(parent, name) {
          throw new FS.ErrnoError(1);
        },readdir:function(node) {
          var entries = ['.', '..'];
          for (var key in node.contents) {
            if (!node.contents.hasOwnProperty(key)) {
              continue;
            }
            entries.push(key);
          }
          return entries;
        },symlink:function(parent, newName, oldPath) {
          throw new FS.ErrnoError(1);
        },readlink:function(node) {
          throw new FS.ErrnoError(1);
        }},stream_ops:{read:function (stream, buffer, offset, length, position) {
          if (position >= stream.node.size) return 0;
          var chunk = stream.node.contents.slice(position, position + length);
          var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
          buffer.set(new Uint8Array(ab), offset);
          return chunk.size;
        },write:function (stream, buffer, offset, length, position) {
          throw new FS.ErrnoError(5);
        },llseek:function (stream, offset, whence) {
          var position = offset;
          if (whence === 1) {  // SEEK_CUR.
            position += stream.position;
          } else if (whence === 2) {  // SEEK_END.
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.size;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(22);
          }
          return position;
        }}};
  
  var ERRNO_MESSAGES={0:"Success",1:"Not super-user",2:"No such file or directory",3:"No such process",4:"Interrupted system call",5:"I/O error",6:"No such device or address",7:"Arg list too long",8:"Exec format error",9:"Bad file number",10:"No children",11:"No more processes",12:"Not enough core",13:"Permission denied",14:"Bad address",15:"Block device required",16:"Mount device busy",17:"File exists",18:"Cross-device link",19:"No such device",20:"Not a directory",21:"Is a directory",22:"Invalid argument",23:"Too many open files in system",24:"Too many open files",25:"Not a typewriter",26:"Text file busy",27:"File too large",28:"No space left on device",29:"Illegal seek",30:"Read only file system",31:"Too many links",32:"Broken pipe",33:"Math arg out of domain of func",34:"Math result not representable",35:"File locking deadlock error",36:"File or path name too long",37:"No record locks available",38:"Function not implemented",39:"Directory not empty",40:"Too many symbolic links",42:"No message of desired type",43:"Identifier removed",44:"Channel number out of range",45:"Level 2 not synchronized",46:"Level 3 halted",47:"Level 3 reset",48:"Link number out of range",49:"Protocol driver not attached",50:"No CSI structure available",51:"Level 2 halted",52:"Invalid exchange",53:"Invalid request descriptor",54:"Exchange full",55:"No anode",56:"Invalid request code",57:"Invalid slot",59:"Bad font file fmt",60:"Device not a stream",61:"No data (for no delay io)",62:"Timer expired",63:"Out of streams resources",64:"Machine is not on the network",65:"Package not installed",66:"The object is remote",67:"The link has been severed",68:"Advertise error",69:"Srmount error",70:"Communication error on send",71:"Protocol error",72:"Multihop attempted",73:"Cross mount point (not really error)",74:"Trying to read unreadable message",75:"Value too large for defined data type",76:"Given log. name not unique",77:"f.d. invalid for this operation",78:"Remote address changed",79:"Can   access a needed shared lib",80:"Accessing a corrupted shared lib",81:".lib section in a.out corrupted",82:"Attempting to link in too many libs",83:"Attempting to exec a shared library",84:"Illegal byte sequence",86:"Streams pipe error",87:"Too many users",88:"Socket operation on non-socket",89:"Destination address required",90:"Message too long",91:"Protocol wrong type for socket",92:"Protocol not available",93:"Unknown protocol",94:"Socket type not supported",95:"Not supported",96:"Protocol family not supported",97:"Address family not supported by protocol family",98:"Address already in use",99:"Address not available",100:"Network interface is not configured",101:"Network is unreachable",102:"Connection reset by network",103:"Connection aborted",104:"Connection reset by peer",105:"No buffer space available",106:"Socket is already connected",107:"Socket is not connected",108:"Can't send after socket shutdown",109:"Too many references",110:"Connection timed out",111:"Connection refused",112:"Host is down",113:"Host is unreachable",114:"Socket already connected",115:"Connection already in progress",116:"Stale file handle",122:"Quota exceeded",123:"No medium (in tape drive)",125:"Operation canceled",130:"Previous owner died",131:"State not recoverable"};
  
  var ERRNO_CODES={EPERM:1,ENOENT:2,ESRCH:3,EINTR:4,EIO:5,ENXIO:6,E2BIG:7,ENOEXEC:8,EBADF:9,ECHILD:10,EAGAIN:11,EWOULDBLOCK:11,ENOMEM:12,EACCES:13,EFAULT:14,ENOTBLK:15,EBUSY:16,EEXIST:17,EXDEV:18,ENODEV:19,ENOTDIR:20,EISDIR:21,EINVAL:22,ENFILE:23,EMFILE:24,ENOTTY:25,ETXTBSY:26,EFBIG:27,ENOSPC:28,ESPIPE:29,EROFS:30,EMLINK:31,EPIPE:32,EDOM:33,ERANGE:34,ENOMSG:42,EIDRM:43,ECHRNG:44,EL2NSYNC:45,EL3HLT:46,EL3RST:47,ELNRNG:48,EUNATCH:49,ENOCSI:50,EL2HLT:51,EDEADLK:35,ENOLCK:37,EBADE:52,EBADR:53,EXFULL:54,ENOANO:55,EBADRQC:56,EBADSLT:57,EDEADLOCK:35,EBFONT:59,ENOSTR:60,ENODATA:61,ETIME:62,ENOSR:63,ENONET:64,ENOPKG:65,EREMOTE:66,ENOLINK:67,EADV:68,ESRMNT:69,ECOMM:70,EPROTO:71,EMULTIHOP:72,EDOTDOT:73,EBADMSG:74,ENOTUNIQ:76,EBADFD:77,EREMCHG:78,ELIBACC:79,ELIBBAD:80,ELIBSCN:81,ELIBMAX:82,ELIBEXEC:83,ENOSYS:38,ENOTEMPTY:39,ENAMETOOLONG:36,ELOOP:40,EOPNOTSUPP:95,EPFNOSUPPORT:96,ECONNRESET:104,ENOBUFS:105,EAFNOSUPPORT:97,EPROTOTYPE:91,ENOTSOCK:88,ENOPROTOOPT:92,ESHUTDOWN:108,ECONNREFUSED:111,EADDRINUSE:98,ECONNABORTED:103,ENETUNREACH:101,ENETDOWN:100,ETIMEDOUT:110,EHOSTDOWN:112,EHOSTUNREACH:113,EINPROGRESS:115,EALREADY:114,EDESTADDRREQ:89,EMSGSIZE:90,EPROTONOSUPPORT:93,ESOCKTNOSUPPORT:94,EADDRNOTAVAIL:99,ENETRESET:102,EISCONN:106,ENOTCONN:107,ETOOMANYREFS:109,EUSERS:87,EDQUOT:122,ESTALE:116,ENOTSUP:95,ENOMEDIUM:123,EILSEQ:84,EOVERFLOW:75,ECANCELED:125,ENOTRECOVERABLE:131,EOWNERDEAD:130,ESTRPIPE:86};var FS={root:null,mounts:[],devices:{},streams:[],nextInode:1,nameTable:null,currentPath:"/",initialized:false,ignorePermissions:true,trackingDelegate:{},tracking:{openFlags:{READ:1,WRITE:2}},ErrnoError:null,genericErrors:{},filesystems:null,syncFSRequests:0,handleFSError:function(e) {
        if (!(e instanceof FS.ErrnoError)) throw e + ' : ' + stackTrace();
        return ___setErrNo(e.errno);
      },lookupPath:function(path, opts) {
        path = PATH_FS.resolve(FS.cwd(), path);
        opts = opts || {};
  
        if (!path) return { path: '', node: null };
  
        var defaults = {
          follow_mount: true,
          recurse_count: 0
        };
        for (var key in defaults) {
          if (opts[key] === undefined) {
            opts[key] = defaults[key];
          }
        }
  
        if (opts.recurse_count > 8) {  // max recursive lookup of 8
          throw new FS.ErrnoError(40);
        }
  
        // split the path
        var parts = PATH.normalizeArray(path.split('/').filter(function(p) {
          return !!p;
        }), false);
  
        // start at the root
        var current = FS.root;
        var current_path = '/';
  
        for (var i = 0; i < parts.length; i++) {
          var islast = (i === parts.length-1);
          if (islast && opts.parent) {
            // stop resolving
            break;
          }
  
          current = FS.lookupNode(current, parts[i]);
          current_path = PATH.join2(current_path, parts[i]);
  
          // jump to the mount's root node if this is a mountpoint
          if (FS.isMountpoint(current)) {
            if (!islast || (islast && opts.follow_mount)) {
              current = current.mounted.root;
            }
          }
  
          // by default, lookupPath will not follow a symlink if it is the final path component.
          // setting opts.follow = true will override this behavior.
          if (!islast || opts.follow) {
            var count = 0;
            while (FS.isLink(current.mode)) {
              var link = FS.readlink(current_path);
              current_path = PATH_FS.resolve(PATH.dirname(current_path), link);
  
              var lookup = FS.lookupPath(current_path, { recurse_count: opts.recurse_count });
              current = lookup.node;
  
              if (count++ > 40) {  // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
                throw new FS.ErrnoError(40);
              }
            }
          }
        }
  
        return { path: current_path, node: current };
      },getPath:function(node) {
        var path;
        while (true) {
          if (FS.isRoot(node)) {
            var mount = node.mount.mountpoint;
            if (!path) return mount;
            return mount[mount.length-1] !== '/' ? mount + '/' + path : mount + path;
          }
          path = path ? node.name + '/' + path : node.name;
          node = node.parent;
        }
      },hashName:function(parentid, name) {
        var hash = 0;
  
  
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        return ((parentid + hash) >>> 0) % FS.nameTable.length;
      },hashAddNode:function(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
      },hashRemoveNode:function(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
          FS.nameTable[hash] = node.name_next;
        } else {
          var current = FS.nameTable[hash];
          while (current) {
            if (current.name_next === node) {
              current.name_next = node.name_next;
              break;
            }
            current = current.name_next;
          }
        }
      },lookupNode:function(parent, name) {
        var err = FS.mayLookup(parent);
        if (err) {
          throw new FS.ErrnoError(err, parent);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
          var nodeName = node.name;
          if (node.parent.id === parent.id && nodeName === name) {
            return node;
          }
        }
        // if we failed to find it in the cache, call into the VFS
        return FS.lookup(parent, name);
      },createNode:function(parent, name, mode, rdev) {
        if (!FS.FSNode) {
          FS.FSNode = function(parent, name, mode, rdev) {
            if (!parent) {
              parent = this;  // root node sets parent to itself
            }
            this.parent = parent;
            this.mount = parent.mount;
            this.mounted = null;
            this.id = FS.nextInode++;
            this.name = name;
            this.mode = mode;
            this.node_ops = {};
            this.stream_ops = {};
            this.rdev = rdev;
          };
  
          FS.FSNode.prototype = {};
  
          // compatibility
          var readMode = 292 | 73;
          var writeMode = 146;
  
          // NOTE we must use Object.defineProperties instead of individual calls to
          // Object.defineProperty in order to make closure compiler happy
          Object.defineProperties(FS.FSNode.prototype, {
            read: {
              get: function() { return (this.mode & readMode) === readMode; },
              set: function(val) { val ? this.mode |= readMode : this.mode &= ~readMode; }
            },
            write: {
              get: function() { return (this.mode & writeMode) === writeMode; },
              set: function(val) { val ? this.mode |= writeMode : this.mode &= ~writeMode; }
            },
            isFolder: {
              get: function() { return FS.isDir(this.mode); }
            },
            isDevice: {
              get: function() { return FS.isChrdev(this.mode); }
            }
          });
        }
  
        var node = new FS.FSNode(parent, name, mode, rdev);
  
        FS.hashAddNode(node);
  
        return node;
      },destroyNode:function(node) {
        FS.hashRemoveNode(node);
      },isRoot:function(node) {
        return node === node.parent;
      },isMountpoint:function(node) {
        return !!node.mounted;
      },isFile:function(mode) {
        return (mode & 61440) === 32768;
      },isDir:function(mode) {
        return (mode & 61440) === 16384;
      },isLink:function(mode) {
        return (mode & 61440) === 40960;
      },isChrdev:function(mode) {
        return (mode & 61440) === 8192;
      },isBlkdev:function(mode) {
        return (mode & 61440) === 24576;
      },isFIFO:function(mode) {
        return (mode & 61440) === 4096;
      },isSocket:function(mode) {
        return (mode & 49152) === 49152;
      },flagModes:{"r":0,"rs":1052672,"r+":2,"w":577,"wx":705,"xw":705,"w+":578,"wx+":706,"xw+":706,"a":1089,"ax":1217,"xa":1217,"a+":1090,"ax+":1218,"xa+":1218},modeStringToFlags:function(str) {
        var flags = FS.flagModes[str];
        if (typeof flags === 'undefined') {
          throw new Error('Unknown file open mode: ' + str);
        }
        return flags;
      },flagsToPermissionString:function(flag) {
        var perms = ['r', 'w', 'rw'][flag & 3];
        if ((flag & 512)) {
          perms += 'w';
        }
        return perms;
      },nodePermissions:function(node, perms) {
        if (FS.ignorePermissions) {
          return 0;
        }
        // return 0 if any user, group or owner bits are set.
        if (perms.indexOf('r') !== -1 && !(node.mode & 292)) {
          return 13;
        } else if (perms.indexOf('w') !== -1 && !(node.mode & 146)) {
          return 13;
        } else if (perms.indexOf('x') !== -1 && !(node.mode & 73)) {
          return 13;
        }
        return 0;
      },mayLookup:function(dir) {
        var err = FS.nodePermissions(dir, 'x');
        if (err) return err;
        if (!dir.node_ops.lookup) return 13;
        return 0;
      },mayCreate:function(dir, name) {
        try {
          var node = FS.lookupNode(dir, name);
          return 17;
        } catch (e) {
        }
        return FS.nodePermissions(dir, 'wx');
      },mayDelete:function(dir, name, isdir) {
        var node;
        try {
          node = FS.lookupNode(dir, name);
        } catch (e) {
          return e.errno;
        }
        var err = FS.nodePermissions(dir, 'wx');
        if (err) {
          return err;
        }
        if (isdir) {
          if (!FS.isDir(node.mode)) {
            return 20;
          }
          if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
            return 16;
          }
        } else {
          if (FS.isDir(node.mode)) {
            return 21;
          }
        }
        return 0;
      },mayOpen:function(node, flags) {
        if (!node) {
          return 2;
        }
        if (FS.isLink(node.mode)) {
          return 40;
        } else if (FS.isDir(node.mode)) {
          if (FS.flagsToPermissionString(flags) !== 'r' || // opening for write
              (flags & 512)) { // TODO: check for O_SEARCH? (== search for dir only)
            return 21;
          }
        }
        return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
      },MAX_OPEN_FDS:4096,nextfd:function(fd_start, fd_end) {
        fd_start = fd_start || 0;
        fd_end = fd_end || FS.MAX_OPEN_FDS;
        for (var fd = fd_start; fd <= fd_end; fd++) {
          if (!FS.streams[fd]) {
            return fd;
          }
        }
        throw new FS.ErrnoError(24);
      },getStream:function(fd) {
        return FS.streams[fd];
      },createStream:function(stream, fd_start, fd_end) {
        if (!FS.FSStream) {
          FS.FSStream = function(){};
          FS.FSStream.prototype = {};
          // compatibility
          Object.defineProperties(FS.FSStream.prototype, {
            object: {
              get: function() { return this.node; },
              set: function(val) { this.node = val; }
            },
            isRead: {
              get: function() { return (this.flags & 2097155) !== 1; }
            },
            isWrite: {
              get: function() { return (this.flags & 2097155) !== 0; }
            },
            isAppend: {
              get: function() { return (this.flags & 1024); }
            }
          });
        }
        // clone it, so we can return an instance of FSStream
        var newStream = new FS.FSStream();
        for (var p in stream) {
          newStream[p] = stream[p];
        }
        stream = newStream;
        var fd = FS.nextfd(fd_start, fd_end);
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
      },closeStream:function(fd) {
        FS.streams[fd] = null;
      },chrdev_stream_ops:{open:function(stream) {
          var device = FS.getDevice(stream.node.rdev);
          // override node's stream ops with the device's
          stream.stream_ops = device.stream_ops;
          // forward the open call
          if (stream.stream_ops.open) {
            stream.stream_ops.open(stream);
          }
        },llseek:function() {
          throw new FS.ErrnoError(29);
        }},major:function(dev) {
        return ((dev) >> 8);
      },minor:function(dev) {
        return ((dev) & 0xff);
      },makedev:function(ma, mi) {
        return ((ma) << 8 | (mi));
      },registerDevice:function(dev, ops) {
        FS.devices[dev] = { stream_ops: ops };
      },getDevice:function(dev) {
        return FS.devices[dev];
      },getMounts:function(mount) {
        var mounts = [];
        var check = [mount];
  
        while (check.length) {
          var m = check.pop();
  
          mounts.push(m);
  
          check.push.apply(check, m.mounts);
        }
  
        return mounts;
      },syncfs:function(populate, callback) {
        if (typeof(populate) === 'function') {
          callback = populate;
          populate = false;
        }
  
        FS.syncFSRequests++;
  
        if (FS.syncFSRequests > 1) {
          console.log('warning: ' + FS.syncFSRequests + ' FS.syncfs operations in flight at once, probably just doing extra work');
        }
  
        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;
  
        function doCallback(err) {
          assert(FS.syncFSRequests > 0);
          FS.syncFSRequests--;
          return callback(err);
        }
  
        function done(err) {
          if (err) {
            if (!done.errored) {
              done.errored = true;
              return doCallback(err);
            }
            return;
          }
          if (++completed >= mounts.length) {
            doCallback(null);
          }
        };
  
        // sync all mounts
        mounts.forEach(function (mount) {
          if (!mount.type.syncfs) {
            return done(null);
          }
          mount.type.syncfs(mount, populate, done);
        });
      },mount:function(type, opts, mountpoint) {
        var root = mountpoint === '/';
        var pseudo = !mountpoint;
        var node;
  
        if (root && FS.root) {
          throw new FS.ErrnoError(16);
        } else if (!root && !pseudo) {
          var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
  
          mountpoint = lookup.path;  // use the absolute path
          node = lookup.node;
  
          if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(16);
          }
  
          if (!FS.isDir(node.mode)) {
            throw new FS.ErrnoError(20);
          }
        }
  
        var mount = {
          type: type,
          opts: opts,
          mountpoint: mountpoint,
          mounts: []
        };
  
        // create a root node for the fs
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;
  
        if (root) {
          FS.root = mountRoot;
        } else if (node) {
          // set as a mountpoint
          node.mounted = mount;
  
          // add the new mount to the current mount's children
          if (node.mount) {
            node.mount.mounts.push(mount);
          }
        }
  
        return mountRoot;
      },unmount:function (mountpoint) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
  
        if (!FS.isMountpoint(lookup.node)) {
          throw new FS.ErrnoError(22);
        }
  
        // destroy the nodes for this mount, and all its child mounts
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);
  
        Object.keys(FS.nameTable).forEach(function (hash) {
          var current = FS.nameTable[hash];
  
          while (current) {
            var next = current.name_next;
  
            if (mounts.indexOf(current.mount) !== -1) {
              FS.destroyNode(current);
            }
  
            current = next;
          }
        });
  
        // no longer a mountpoint
        node.mounted = null;
  
        // remove this mount from the child mounts
        var idx = node.mount.mounts.indexOf(mount);
        assert(idx !== -1);
        node.mount.mounts.splice(idx, 1);
      },lookup:function(parent, name) {
        return parent.node_ops.lookup(parent, name);
      },mknod:function(path, mode, dev) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        if (!name || name === '.' || name === '..') {
          throw new FS.ErrnoError(22);
        }
        var err = FS.mayCreate(parent, name);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.mknod) {
          throw new FS.ErrnoError(1);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
      },create:function(path, mode) {
        mode = mode !== undefined ? mode : 438 /* 0666 */;
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
      },mkdir:function(path, mode) {
        mode = mode !== undefined ? mode : 511 /* 0777 */;
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
      },mkdirTree:function(path, mode) {
        var dirs = path.split('/');
        var d = '';
        for (var i = 0; i < dirs.length; ++i) {
          if (!dirs[i]) continue;
          d += '/' + dirs[i];
          try {
            FS.mkdir(d, mode);
          } catch(e) {
            if (e.errno != 17) throw e;
          }
        }
      },mkdev:function(path, mode, dev) {
        if (typeof(dev) === 'undefined') {
          dev = mode;
          mode = 438 /* 0666 */;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
      },symlink:function(oldpath, newpath) {
        if (!PATH_FS.resolve(oldpath)) {
          throw new FS.ErrnoError(2);
        }
        var lookup = FS.lookupPath(newpath, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(2);
        }
        var newname = PATH.basename(newpath);
        var err = FS.mayCreate(parent, newname);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.symlink) {
          throw new FS.ErrnoError(1);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
      },rename:function(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        // parents must exist
        var lookup, old_dir, new_dir;
        try {
          lookup = FS.lookupPath(old_path, { parent: true });
          old_dir = lookup.node;
          lookup = FS.lookupPath(new_path, { parent: true });
          new_dir = lookup.node;
        } catch (e) {
          throw new FS.ErrnoError(16);
        }
        if (!old_dir || !new_dir) throw new FS.ErrnoError(2);
        // need to be part of the same mount
        if (old_dir.mount !== new_dir.mount) {
          throw new FS.ErrnoError(18);
        }
        // source must exist
        var old_node = FS.lookupNode(old_dir, old_name);
        // old path should not be an ancestor of the new path
        var relative = PATH_FS.relative(old_path, new_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(22);
        }
        // new path should not be an ancestor of the old path
        relative = PATH_FS.relative(new_path, old_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(39);
        }
        // see if the new path already exists
        var new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {
          // not fatal
        }
        // early out if nothing needs to change
        if (old_node === new_node) {
          return;
        }
        // we'll need to delete the old entry
        var isdir = FS.isDir(old_node.mode);
        var err = FS.mayDelete(old_dir, old_name, isdir);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        // need delete permissions if we'll be overwriting.
        // need create permissions if new doesn't already exist.
        err = new_node ?
          FS.mayDelete(new_dir, new_name, isdir) :
          FS.mayCreate(new_dir, new_name);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!old_dir.node_ops.rename) {
          throw new FS.ErrnoError(1);
        }
        if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
          throw new FS.ErrnoError(16);
        }
        // if we are going to change the parent, check write permissions
        if (new_dir !== old_dir) {
          err = FS.nodePermissions(old_dir, 'w');
          if (err) {
            throw new FS.ErrnoError(err);
          }
        }
        try {
          if (FS.trackingDelegate['willMovePath']) {
            FS.trackingDelegate['willMovePath'](old_path, new_path);
          }
        } catch(e) {
          console.log("FS.trackingDelegate['willMovePath']('"+old_path+"', '"+new_path+"') threw an exception: " + e.message);
        }
        // remove the node from the lookup hash
        FS.hashRemoveNode(old_node);
        // do the underlying fs rename
        try {
          old_dir.node_ops.rename(old_node, new_dir, new_name);
        } catch (e) {
          throw e;
        } finally {
          // add the node back to the hash (in case node_ops.rename
          // changed its name)
          FS.hashAddNode(old_node);
        }
        try {
          if (FS.trackingDelegate['onMovePath']) FS.trackingDelegate['onMovePath'](old_path, new_path);
        } catch(e) {
          console.log("FS.trackingDelegate['onMovePath']('"+old_path+"', '"+new_path+"') threw an exception: " + e.message);
        }
      },rmdir:function(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, true);
        if (err) {
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.rmdir) {
          throw new FS.ErrnoError(1);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(16);
        }
        try {
          if (FS.trackingDelegate['willDeletePath']) {
            FS.trackingDelegate['willDeletePath'](path);
          }
        } catch(e) {
          console.log("FS.trackingDelegate['willDeletePath']('"+path+"') threw an exception: " + e.message);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
        try {
          if (FS.trackingDelegate['onDeletePath']) FS.trackingDelegate['onDeletePath'](path);
        } catch(e) {
          console.log("FS.trackingDelegate['onDeletePath']('"+path+"') threw an exception: " + e.message);
        }
      },readdir:function(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        if (!node.node_ops.readdir) {
          throw new FS.ErrnoError(20);
        }
        return node.node_ops.readdir(node);
      },unlink:function(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, false);
        if (err) {
          // According to POSIX, we should map EISDIR to EPERM, but
          // we instead do what Linux does (and we must, as we use
          // the musl linux libc).
          throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.unlink) {
          throw new FS.ErrnoError(1);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(16);
        }
        try {
          if (FS.trackingDelegate['willDeletePath']) {
            FS.trackingDelegate['willDeletePath'](path);
          }
        } catch(e) {
          console.log("FS.trackingDelegate['willDeletePath']('"+path+"') threw an exception: " + e.message);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
        try {
          if (FS.trackingDelegate['onDeletePath']) FS.trackingDelegate['onDeletePath'](path);
        } catch(e) {
          console.log("FS.trackingDelegate['onDeletePath']('"+path+"') threw an exception: " + e.message);
        }
      },readlink:function(path) {
        var lookup = FS.lookupPath(path);
        var link = lookup.node;
        if (!link) {
          throw new FS.ErrnoError(2);
        }
        if (!link.node_ops.readlink) {
          throw new FS.ErrnoError(22);
        }
        return PATH_FS.resolve(FS.getPath(link.parent), link.node_ops.readlink(link));
      },stat:function(path, dontFollow) {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        var node = lookup.node;
        if (!node) {
          throw new FS.ErrnoError(2);
        }
        if (!node.node_ops.getattr) {
          throw new FS.ErrnoError(1);
        }
        return node.node_ops.getattr(node);
      },lstat:function(path) {
        return FS.stat(path, true);
      },chmod:function(path, mode, dontFollow) {
        var node;
        if (typeof path === 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(1);
        }
        node.node_ops.setattr(node, {
          mode: (mode & 4095) | (node.mode & ~4095),
          timestamp: Date.now()
        });
      },lchmod:function(path, mode) {
        FS.chmod(path, mode, true);
      },fchmod:function(fd, mode) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(9);
        }
        FS.chmod(stream.node, mode);
      },chown:function(path, uid, gid, dontFollow) {
        var node;
        if (typeof path === 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(1);
        }
        node.node_ops.setattr(node, {
          timestamp: Date.now()
          // we ignore the uid / gid for now
        });
      },lchown:function(path, uid, gid) {
        FS.chown(path, uid, gid, true);
      },fchown:function(fd, uid, gid) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(9);
        }
        FS.chown(stream.node, uid, gid);
      },truncate:function(path, len) {
        if (len < 0) {
          throw new FS.ErrnoError(22);
        }
        var node;
        if (typeof path === 'string') {
          var lookup = FS.lookupPath(path, { follow: true });
          node = lookup.node;
        } else {
          node = path;
        }
        if (!node.node_ops.setattr) {
          throw new FS.ErrnoError(1);
        }
        if (FS.isDir(node.mode)) {
          throw new FS.ErrnoError(21);
        }
        if (!FS.isFile(node.mode)) {
          throw new FS.ErrnoError(22);
        }
        var err = FS.nodePermissions(node, 'w');
        if (err) {
          throw new FS.ErrnoError(err);
        }
        node.node_ops.setattr(node, {
          size: len,
          timestamp: Date.now()
        });
      },ftruncate:function(fd, len) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(9);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(22);
        }
        FS.truncate(stream.node, len);
      },utime:function(path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        node.node_ops.setattr(node, {
          timestamp: Math.max(atime, mtime)
        });
      },open:function(path, flags, mode, fd_start, fd_end) {
        if (path === "") {
          throw new FS.ErrnoError(2);
        }
        flags = typeof flags === 'string' ? FS.modeStringToFlags(flags) : flags;
        mode = typeof mode === 'undefined' ? 438 /* 0666 */ : mode;
        if ((flags & 64)) {
          mode = (mode & 4095) | 32768;
        } else {
          mode = 0;
        }
        var node;
        if (typeof path === 'object') {
          node = path;
        } else {
          path = PATH.normalize(path);
          try {
            var lookup = FS.lookupPath(path, {
              follow: !(flags & 131072)
            });
            node = lookup.node;
          } catch (e) {
            // ignore
          }
        }
        // perhaps we need to create the node
        var created = false;
        if ((flags & 64)) {
          if (node) {
            // if O_CREAT and O_EXCL are set, error out if the node already exists
            if ((flags & 128)) {
              throw new FS.ErrnoError(17);
            }
          } else {
            // node doesn't exist, try to create it
            node = FS.mknod(path, mode, 0);
            created = true;
          }
        }
        if (!node) {
          throw new FS.ErrnoError(2);
        }
        // can't truncate a device
        if (FS.isChrdev(node.mode)) {
          flags &= ~512;
        }
        // if asked only for a directory, then this must be one
        if ((flags & 65536) && !FS.isDir(node.mode)) {
          throw new FS.ErrnoError(20);
        }
        // check permissions, if this is not a file we just created now (it is ok to
        // create and write to a file with read-only permissions; it is read-only
        // for later use)
        if (!created) {
          var err = FS.mayOpen(node, flags);
          if (err) {
            throw new FS.ErrnoError(err);
          }
        }
        // do truncation if necessary
        if ((flags & 512)) {
          FS.truncate(node, 0);
        }
        // we've already handled these, don't pass down to the underlying vfs
        flags &= ~(128 | 512);
  
        // register the stream with the filesystem
        var stream = FS.createStream({
          node: node,
          path: FS.getPath(node),  // we want the absolute path to the node
          flags: flags,
          seekable: true,
          position: 0,
          stream_ops: node.stream_ops,
          // used by the file family libc calls (fopen, fwrite, ferror, etc.)
          ungotten: [],
          error: false
        }, fd_start, fd_end);
        // call the new stream's open function
        if (stream.stream_ops.open) {
          stream.stream_ops.open(stream);
        }
        if (Module['logReadFiles'] && !(flags & 1)) {
          if (!FS.readFiles) FS.readFiles = {};
          if (!(path in FS.readFiles)) {
            FS.readFiles[path] = 1;
            console.log("FS.trackingDelegate error on read file: " + path);
          }
        }
        try {
          if (FS.trackingDelegate['onOpenFile']) {
            var trackingFlags = 0;
            if ((flags & 2097155) !== 1) {
              trackingFlags |= FS.tracking.openFlags.READ;
            }
            if ((flags & 2097155) !== 0) {
              trackingFlags |= FS.tracking.openFlags.WRITE;
            }
            FS.trackingDelegate['onOpenFile'](path, trackingFlags);
          }
        } catch(e) {
          console.log("FS.trackingDelegate['onOpenFile']('"+path+"', flags) threw an exception: " + e.message);
        }
        return stream;
      },close:function(stream) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(9);
        }
        if (stream.getdents) stream.getdents = null; // free readdir state
        try {
          if (stream.stream_ops.close) {
            stream.stream_ops.close(stream);
          }
        } catch (e) {
          throw e;
        } finally {
          FS.closeStream(stream.fd);
        }
        stream.fd = null;
      },isClosed:function(stream) {
        return stream.fd === null;
      },llseek:function(stream, offset, whence) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(9);
        }
        if (!stream.seekable || !stream.stream_ops.llseek) {
          throw new FS.ErrnoError(29);
        }
        if (whence != 0 /* SEEK_SET */ && whence != 1 /* SEEK_CUR */ && whence != 2 /* SEEK_END */) {
          throw new FS.ErrnoError(22);
        }
        stream.position = stream.stream_ops.llseek(stream, offset, whence);
        stream.ungotten = [];
        return stream.position;
      },read:function(stream, buffer, offset, length, position) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(22);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(9);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(9);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(21);
        }
        if (!stream.stream_ops.read) {
          throw new FS.ErrnoError(22);
        }
        var seeking = typeof position !== 'undefined';
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(29);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
      },write:function(stream, buffer, offset, length, position, canOwn) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(22);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(9);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(9);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(21);
        }
        if (!stream.stream_ops.write) {
          throw new FS.ErrnoError(22);
        }
        if (stream.flags & 1024) {
          // seek to the end before writing in append mode
          FS.llseek(stream, 0, 2);
        }
        var seeking = typeof position !== 'undefined';
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(29);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        try {
          if (stream.path && FS.trackingDelegate['onWriteToFile']) FS.trackingDelegate['onWriteToFile'](stream.path);
        } catch(e) {
          console.log("FS.trackingDelegate['onWriteToFile']('"+stream.path+"') threw an exception: " + e.message);
        }
        return bytesWritten;
      },allocate:function(stream, offset, length) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(9);
        }
        if (offset < 0 || length <= 0) {
          throw new FS.ErrnoError(22);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(9);
        }
        if (!FS.isFile(stream.node.mode) && !FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(19);
        }
        if (!stream.stream_ops.allocate) {
          throw new FS.ErrnoError(95);
        }
        stream.stream_ops.allocate(stream, offset, length);
      },mmap:function(stream, buffer, offset, length, position, prot, flags) {
        // User requests writing to file (prot & PROT_WRITE != 0).
        // Checking if we have permissions to write to the file unless
        // MAP_PRIVATE flag is set. According to POSIX spec it is possible
        // to write to file opened in read-only mode with MAP_PRIVATE flag,
        // as all modifications will be visible only in the memory of
        // the current process.
        if ((prot & 2) !== 0
            && (flags & 2) === 0
            && (stream.flags & 2097155) !== 2) {
          throw new FS.ErrnoError(13);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(13);
        }
        if (!stream.stream_ops.mmap) {
          throw new FS.ErrnoError(19);
        }
        return stream.stream_ops.mmap(stream, buffer, offset, length, position, prot, flags);
      },msync:function(stream, buffer, offset, length, mmapFlags) {
        if (!stream || !stream.stream_ops.msync) {
          return 0;
        }
        return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
      },munmap:function(stream) {
        return 0;
      },ioctl:function(stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
          throw new FS.ErrnoError(25);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
      },readFile:function(path, opts) {
        opts = opts || {};
        opts.flags = opts.flags || 'r';
        opts.encoding = opts.encoding || 'binary';
        if (opts.encoding !== 'utf8' && opts.encoding !== 'binary') {
          throw new Error('Invalid encoding type "' + opts.encoding + '"');
        }
        var ret;
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === 'utf8') {
          ret = UTF8ArrayToString(buf, 0);
        } else if (opts.encoding === 'binary') {
          ret = buf;
        }
        FS.close(stream);
        return ret;
      },writeFile:function(path, data, opts) {
        opts = opts || {};
        opts.flags = opts.flags || 'w';
        var stream = FS.open(path, opts.flags, opts.mode);
        if (typeof data === 'string') {
          var buf = new Uint8Array(lengthBytesUTF8(data)+1);
          var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
          FS.write(stream, buf, 0, actualNumBytes, undefined, opts.canOwn);
        } else if (ArrayBuffer.isView(data)) {
          FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
        } else {
          throw new Error('Unsupported data type');
        }
        FS.close(stream);
      },cwd:function() {
        return FS.currentPath;
      },chdir:function(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (lookup.node === null) {
          throw new FS.ErrnoError(2);
        }
        if (!FS.isDir(lookup.node.mode)) {
          throw new FS.ErrnoError(20);
        }
        var err = FS.nodePermissions(lookup.node, 'x');
        if (err) {
          throw new FS.ErrnoError(err);
        }
        FS.currentPath = lookup.path;
      },createDefaultDirectories:function() {
        FS.mkdir('/tmp');
        FS.mkdir('/home');
        FS.mkdir('/home/web_user');
      },createDefaultDevices:function() {
        // create /dev
        FS.mkdir('/dev');
        // setup /dev/null
        FS.registerDevice(FS.makedev(1, 3), {
          read: function() { return 0; },
          write: function(stream, buffer, offset, length, pos) { return length; }
        });
        FS.mkdev('/dev/null', FS.makedev(1, 3));
        // setup /dev/tty and /dev/tty1
        // stderr needs to print output using Module['printErr']
        // so we register a second tty just for it.
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev('/dev/tty', FS.makedev(5, 0));
        FS.mkdev('/dev/tty1', FS.makedev(6, 0));
        // setup /dev/[u]random
        var random_device;
        if (typeof crypto === 'object' && typeof crypto['getRandomValues'] === 'function') {
          // for modern web browsers
          var randomBuffer = new Uint8Array(1);
          random_device = function() { crypto.getRandomValues(randomBuffer); return randomBuffer[0]; };
        } else
        if (ENVIRONMENT_IS_NODE) {
          // for nodejs with or without crypto support included
          try {
            var crypto_module = require('crypto');
            // nodejs has crypto support
            random_device = function() { return crypto_module['randomBytes'](1)[0]; };
          } catch (e) {
            // nodejs doesn't have crypto support
          }
        } else
        {}
        if (!random_device) {
          // we couldn't find a proper implementation, as Math.random() is not suitable for /dev/random, see emscripten-core/emscripten/pull/7096
          random_device = function() { abort("no cryptographic support found for random_device. consider polyfilling it if you want to use something insecure like Math.random(), e.g. put this in a --pre-js: var crypto = { getRandomValues: function(array) { for (var i = 0; i < array.length; i++) array[i] = (Math.random()*256)|0 } };"); };
        }
        FS.createDevice('/dev', 'random', random_device);
        FS.createDevice('/dev', 'urandom', random_device);
        // we're not going to emulate the actual shm device,
        // just create the tmp dirs that reside in it commonly
        FS.mkdir('/dev/shm');
        FS.mkdir('/dev/shm/tmp');
      },createSpecialDirectories:function() {
        // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the name of the stream for fd 6 (see test_unistd_ttyname)
        FS.mkdir('/proc');
        FS.mkdir('/proc/self');
        FS.mkdir('/proc/self/fd');
        FS.mount({
          mount: function() {
            var node = FS.createNode('/proc/self', 'fd', 16384 | 511 /* 0777 */, 73);
            node.node_ops = {
              lookup: function(parent, name) {
                var fd = +name;
                var stream = FS.getStream(fd);
                if (!stream) throw new FS.ErrnoError(9);
                var ret = {
                  parent: null,
                  mount: { mountpoint: 'fake' },
                  node_ops: { readlink: function() { return stream.path } }
                };
                ret.parent = ret; // make it look like a simple root node
                return ret;
              }
            };
            return node;
          }
        }, {}, '/proc/self/fd');
      },createStandardStreams:function() {
        // TODO deprecate the old functionality of a single
        // input / output callback and that utilizes FS.createDevice
        // and instead require a unique set of stream ops
  
        // by default, we symlink the standard streams to the
        // default tty devices. however, if the standard streams
        // have been overwritten we create a unique device for
        // them instead.
        if (Module['stdin']) {
          FS.createDevice('/dev', 'stdin', Module['stdin']);
        } else {
          FS.symlink('/dev/tty', '/dev/stdin');
        }
        if (Module['stdout']) {
          FS.createDevice('/dev', 'stdout', null, Module['stdout']);
        } else {
          FS.symlink('/dev/tty', '/dev/stdout');
        }
        if (Module['stderr']) {
          FS.createDevice('/dev', 'stderr', null, Module['stderr']);
        } else {
          FS.symlink('/dev/tty1', '/dev/stderr');
        }
  
        // open default streams for the stdin, stdout and stderr devices
        var stdin = FS.open('/dev/stdin', 'r');
        var stdout = FS.open('/dev/stdout', 'w');
        var stderr = FS.open('/dev/stderr', 'w');
        assert(stdin.fd === 0, 'invalid handle for stdin (' + stdin.fd + ')');
        assert(stdout.fd === 1, 'invalid handle for stdout (' + stdout.fd + ')');
        assert(stderr.fd === 2, 'invalid handle for stderr (' + stderr.fd + ')');
      },ensureErrnoError:function() {
        if (FS.ErrnoError) return;
        FS.ErrnoError = function ErrnoError(errno, node) {
          this.node = node;
          this.setErrno = function(errno) {
            this.errno = errno;
            for (var key in ERRNO_CODES) {
              if (ERRNO_CODES[key] === errno) {
                this.code = key;
                break;
              }
            }
          };
          this.setErrno(errno);
          this.message = ERRNO_MESSAGES[errno];
  
          // Try to get a maximally helpful stack trace. On Node.js, getting Error.stack
          // now ensures it shows what we want.
          if (this.stack) {
            // Define the stack property for Node.js 4, which otherwise errors on the next line.
            Object.defineProperty(this, "stack", { value: (new Error).stack, writable: true });
            this.stack = demangleAll(this.stack);
          }
        };
        FS.ErrnoError.prototype = new Error();
        FS.ErrnoError.prototype.constructor = FS.ErrnoError;
        // Some errors may happen quite a bit, to avoid overhead we reuse them (and suffer a lack of stack info)
        [2].forEach(function(code) {
          FS.genericErrors[code] = new FS.ErrnoError(code);
          FS.genericErrors[code].stack = '<generic error, no stack>';
        });
      },staticInit:function() {
        FS.ensureErrnoError();
  
        FS.nameTable = new Array(4096);
  
        FS.mount(MEMFS, {}, '/');
  
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
        FS.createSpecialDirectories();
  
        FS.filesystems = {
          'MEMFS': MEMFS,
          'IDBFS': IDBFS,
          'NODEFS': NODEFS,
          'WORKERFS': WORKERFS,
        };
      },init:function(input, output, error) {
        assert(!FS.init.initialized, 'FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)');
        FS.init.initialized = true;
  
        FS.ensureErrnoError();
  
        // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
        Module['stdin'] = input || Module['stdin'];
        Module['stdout'] = output || Module['stdout'];
        Module['stderr'] = error || Module['stderr'];
  
        FS.createStandardStreams();
      },quit:function() {
        FS.init.initialized = false;
        // force-flush all streams, so we get musl std streams printed out
        var fflush = Module['_fflush'];
        if (fflush) fflush(0);
        // close all of our streams
        for (var i = 0; i < FS.streams.length; i++) {
          var stream = FS.streams[i];
          if (!stream) {
            continue;
          }
          FS.close(stream);
        }
      },getMode:function(canRead, canWrite) {
        var mode = 0;
        if (canRead) mode |= 292 | 73;
        if (canWrite) mode |= 146;
        return mode;
      },joinPath:function(parts, forceRelative) {
        var path = PATH.join.apply(null, parts);
        if (forceRelative && path[0] == '/') path = path.substr(1);
        return path;
      },absolutePath:function(relative, base) {
        return PATH_FS.resolve(base, relative);
      },standardizePath:function(path) {
        return PATH.normalize(path);
      },findObject:function(path, dontResolveLastLink) {
        var ret = FS.analyzePath(path, dontResolveLastLink);
        if (ret.exists) {
          return ret.object;
        } else {
          ___setErrNo(ret.error);
          return null;
        }
      },analyzePath:function(path, dontResolveLastLink) {
        // operate from within the context of the symlink's target
        try {
          var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          path = lookup.path;
        } catch (e) {
        }
        var ret = {
          isRoot: false, exists: false, error: 0, name: null, path: null, object: null,
          parentExists: false, parentPath: null, parentObject: null
        };
        try {
          var lookup = FS.lookupPath(path, { parent: true });
          ret.parentExists = true;
          ret.parentPath = lookup.path;
          ret.parentObject = lookup.node;
          ret.name = PATH.basename(path);
          lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          ret.exists = true;
          ret.path = lookup.path;
          ret.object = lookup.node;
          ret.name = lookup.node.name;
          ret.isRoot = lookup.path === '/';
        } catch (e) {
          ret.error = e.errno;
        };
        return ret;
      },createFolder:function(parent, name, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(canRead, canWrite);
        return FS.mkdir(path, mode);
      },createPath:function(parent, path, canRead, canWrite) {
        parent = typeof parent === 'string' ? parent : FS.getPath(parent);
        var parts = path.split('/').reverse();
        while (parts.length) {
          var part = parts.pop();
          if (!part) continue;
          var current = PATH.join2(parent, part);
          try {
            FS.mkdir(current);
          } catch (e) {
            // ignore EEXIST
          }
          parent = current;
        }
        return current;
      },createFile:function(parent, name, properties, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(canRead, canWrite);
        return FS.create(path, mode);
      },createDataFile:function(parent, name, data, canRead, canWrite, canOwn) {
        var path = name ? PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name) : parent;
        var mode = FS.getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
          if (typeof data === 'string') {
            var arr = new Array(data.length);
            for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
            data = arr;
          }
          // make sure we can write to the file
          FS.chmod(node, mode | 146);
          var stream = FS.open(node, 'w');
          FS.write(stream, data, 0, data.length, 0, canOwn);
          FS.close(stream);
          FS.chmod(node, mode);
        }
        return node;
      },createDevice:function(parent, name, input, output) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(!!input, !!output);
        if (!FS.createDevice.major) FS.createDevice.major = 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        // Create a fake device that a set of stream ops to emulate
        // the old behavior.
        FS.registerDevice(dev, {
          open: function(stream) {
            stream.seekable = false;
          },
          close: function(stream) {
            // flush any pending line data
            if (output && output.buffer && output.buffer.length) {
              output(10);
            }
          },
          read: function(stream, buffer, offset, length, pos /* ignored */) {
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
              var result;
              try {
                result = input();
              } catch (e) {
                throw new FS.ErrnoError(5);
              }
              if (result === undefined && bytesRead === 0) {
                throw new FS.ErrnoError(11);
              }
              if (result === null || result === undefined) break;
              bytesRead++;
              buffer[offset+i] = result;
            }
            if (bytesRead) {
              stream.node.timestamp = Date.now();
            }
            return bytesRead;
          },
          write: function(stream, buffer, offset, length, pos) {
            for (var i = 0; i < length; i++) {
              try {
                output(buffer[offset+i]);
              } catch (e) {
                throw new FS.ErrnoError(5);
              }
            }
            if (length) {
              stream.node.timestamp = Date.now();
            }
            return i;
          }
        });
        return FS.mkdev(path, mode, dev);
      },createLink:function(parent, name, target, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        return FS.symlink(target, path);
      },forceLoadFile:function(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        var success = true;
        if (typeof XMLHttpRequest !== 'undefined') {
          throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
        } else if (read_) {
          // Command-line.
          try {
            // WARNING: Can't read binary files in V8's d8 or tracemonkey's js, as
            //          read() will try to parse UTF8.
            obj.contents = intArrayFromString(read_(obj.url), true);
            obj.usedBytes = obj.contents.length;
          } catch (e) {
            success = false;
          }
        } else {
          throw new Error('Cannot load without read() or XMLHttpRequest.');
        }
        if (!success) ___setErrNo(5);
        return success;
      },createLazyFile:function(parent, name, url, canRead, canWrite) {
        // Lazy chunked Uint8Array (implements get and length from Uint8Array). Actual getting is abstracted away for eventual reuse.
        function LazyUint8Array() {
          this.lengthKnown = false;
          this.chunks = []; // Loaded chunks. Index is the chunk number
        }
        LazyUint8Array.prototype.get = function LazyUint8Array_get(idx) {
          if (idx > this.length-1 || idx < 0) {
            return undefined;
          }
          var chunkOffset = idx % this.chunkSize;
          var chunkNum = (idx / this.chunkSize)|0;
          return this.getter(chunkNum)[chunkOffset];
        };
        LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
          this.getter = getter;
        };
        LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
          // Find length
          var xhr = new XMLHttpRequest();
          xhr.open('HEAD', url, false);
          xhr.send(null);
          if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
          var datalength = Number(xhr.getResponseHeader("Content-length"));
          var header;
          var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
          var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
  
          var chunkSize = 1024*1024; // Chunk size in bytes
  
          if (!hasByteServing) chunkSize = datalength;
  
          // Function to get a range from the remote URL.
          var doXHR = (function(from, to) {
            if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
            if (to > datalength-1) throw new Error("only " + datalength + " bytes available! programmer error!");
  
            // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, false);
            if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
  
            // Some hints to the browser that we want binary data.
            if (typeof Uint8Array != 'undefined') xhr.responseType = 'arraybuffer';
            if (xhr.overrideMimeType) {
              xhr.overrideMimeType('text/plain; charset=x-user-defined');
            }
  
            xhr.send(null);
            if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
            if (xhr.response !== undefined) {
              return new Uint8Array(xhr.response || []);
            } else {
              return intArrayFromString(xhr.responseText || '', true);
            }
          });
          var lazyArray = this;
          lazyArray.setDataGetter(function(chunkNum) {
            var start = chunkNum * chunkSize;
            var end = (chunkNum+1) * chunkSize - 1; // including this byte
            end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
            if (typeof(lazyArray.chunks[chunkNum]) === "undefined") {
              lazyArray.chunks[chunkNum] = doXHR(start, end);
            }
            if (typeof(lazyArray.chunks[chunkNum]) === "undefined") throw new Error("doXHR failed!");
            return lazyArray.chunks[chunkNum];
          });
  
          if (usesGzip || !datalength) {
            // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
            chunkSize = datalength = 1; // this will force getter(0)/doXHR do download the whole file
            datalength = this.getter(0).length;
            chunkSize = datalength;
            console.log("LazyFiles on gzip forces download of the whole file when length is accessed");
          }
  
          this._length = datalength;
          this._chunkSize = chunkSize;
          this.lengthKnown = true;
        };
        if (typeof XMLHttpRequest !== 'undefined') {
          if (!ENVIRONMENT_IS_WORKER) throw 'Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc';
          var lazyArray = new LazyUint8Array();
          Object.defineProperties(lazyArray, {
            length: {
              get: function() {
                if(!this.lengthKnown) {
                  this.cacheLength();
                }
                return this._length;
              }
            },
            chunkSize: {
              get: function() {
                if(!this.lengthKnown) {
                  this.cacheLength();
                }
                return this._chunkSize;
              }
            }
          });
  
          var properties = { isDevice: false, contents: lazyArray };
        } else {
          var properties = { isDevice: false, url: url };
        }
  
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        // This is a total hack, but I want to get this lazy file code out of the
        // core of MEMFS. If we want to keep this lazy file concept I feel it should
        // be its own thin LAZYFS proxying calls to MEMFS.
        if (properties.contents) {
          node.contents = properties.contents;
        } else if (properties.url) {
          node.contents = null;
          node.url = properties.url;
        }
        // Add a function that defers querying the file size until it is asked the first time.
        Object.defineProperties(node, {
          usedBytes: {
            get: function() { return this.contents.length; }
          }
        });
        // override each stream op with one that tries to force load the lazy file first
        var stream_ops = {};
        var keys = Object.keys(node.stream_ops);
        keys.forEach(function(key) {
          var fn = node.stream_ops[key];
          stream_ops[key] = function forceLoadLazyFile() {
            if (!FS.forceLoadFile(node)) {
              throw new FS.ErrnoError(5);
            }
            return fn.apply(null, arguments);
          };
        });
        // use a custom read function
        stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
          if (!FS.forceLoadFile(node)) {
            throw new FS.ErrnoError(5);
          }
          var contents = stream.node.contents;
          if (position >= contents.length)
            return 0;
          var size = Math.min(contents.length - position, length);
          assert(size >= 0);
          if (contents.slice) { // normal array
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents[position + i];
            }
          } else {
            for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
              buffer[offset + i] = contents.get(position + i);
            }
          }
          return size;
        };
        node.stream_ops = stream_ops;
        return node;
      },createPreloadedFile:function(parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) {
        Browser.init(); // XXX perhaps this method should move onto Browser?
        // TODO we should allow people to just pass in a complete filename instead
        // of parent and name being that we just join them anyways
        var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
        var dep = getUniqueRunDependency('cp ' + fullname); // might have several active requests for the same fullname
        function processData(byteArray) {
          function finish(byteArray) {
            if (preFinish) preFinish();
            if (!dontCreateFile) {
              FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
            }
            if (onload) onload();
            removeRunDependency(dep);
          }
          var handled = false;
          Module['preloadPlugins'].forEach(function(plugin) {
            if (handled) return;
            if (plugin['canHandle'](fullname)) {
              plugin['handle'](byteArray, fullname, finish, function() {
                if (onerror) onerror();
                removeRunDependency(dep);
              });
              handled = true;
            }
          });
          if (!handled) finish(byteArray);
        }
        addRunDependency(dep);
        if (typeof url == 'string') {
          Browser.asyncLoad(url, function(byteArray) {
            processData(byteArray);
          }, onerror);
        } else {
          processData(url);
        }
      },indexedDB:function() {
        return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
      },DB_NAME:function() {
        return 'EM_FS_' + window.location.pathname;
      },DB_VERSION:20,DB_STORE_NAME:"FILE_DATA",saveFilesToDB:function(paths, onload, onerror) {
        onload = onload || function(){};
        onerror = onerror || function(){};
        var indexedDB = FS.indexedDB();
        try {
          var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
        } catch (e) {
          return onerror(e);
        }
        openRequest.onupgradeneeded = function openRequest_onupgradeneeded() {
          console.log('creating db');
          var db = openRequest.result;
          db.createObjectStore(FS.DB_STORE_NAME);
        };
        openRequest.onsuccess = function openRequest_onsuccess() {
          var db = openRequest.result;
          var transaction = db.transaction([FS.DB_STORE_NAME], 'readwrite');
          var files = transaction.objectStore(FS.DB_STORE_NAME);
          var ok = 0, fail = 0, total = paths.length;
          function finish() {
            if (fail == 0) onload(); else onerror();
          }
          paths.forEach(function(path) {
            var putRequest = files.put(FS.analyzePath(path).object.contents, path);
            putRequest.onsuccess = function putRequest_onsuccess() { ok++; if (ok + fail == total) finish() };
            putRequest.onerror = function putRequest_onerror() { fail++; if (ok + fail == total) finish() };
          });
          transaction.onerror = onerror;
        };
        openRequest.onerror = onerror;
      },loadFilesFromDB:function(paths, onload, onerror) {
        onload = onload || function(){};
        onerror = onerror || function(){};
        var indexedDB = FS.indexedDB();
        try {
          var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
        } catch (e) {
          return onerror(e);
        }
        openRequest.onupgradeneeded = onerror; // no database to load from
        openRequest.onsuccess = function openRequest_onsuccess() {
          var db = openRequest.result;
          try {
            var transaction = db.transaction([FS.DB_STORE_NAME], 'readonly');
          } catch(e) {
            onerror(e);
            return;
          }
          var files = transaction.objectStore(FS.DB_STORE_NAME);
          var ok = 0, fail = 0, total = paths.length;
          function finish() {
            if (fail == 0) onload(); else onerror();
          }
          paths.forEach(function(path) {
            var getRequest = files.get(path);
            getRequest.onsuccess = function getRequest_onsuccess() {
              if (FS.analyzePath(path).exists) {
                FS.unlink(path);
              }
              FS.createDataFile(PATH.dirname(path), PATH.basename(path), getRequest.result, true, true, true);
              ok++;
              if (ok + fail == total) finish();
            };
            getRequest.onerror = function getRequest_onerror() { fail++; if (ok + fail == total) finish() };
          });
          transaction.onerror = onerror;
        };
        openRequest.onerror = onerror;
      }};var SYSCALLS={DEFAULT_POLLMASK:5,mappings:{},umask:511,calculateAt:function(dirfd, path) {
        if (path[0] !== '/') {
          // relative path
          var dir;
          if (dirfd === -100) {
            dir = FS.cwd();
          } else {
            var dirstream = FS.getStream(dirfd);
            if (!dirstream) throw new FS.ErrnoError(9);
            dir = dirstream.path;
          }
          path = PATH.join2(dir, path);
        }
        return path;
      },doStat:function(func, path, buf) {
        try {
          var stat = func(path);
        } catch (e) {
          if (e && e.node && PATH.normalize(path) !== PATH.normalize(FS.getPath(e.node))) {
            // an error occurred while trying to look up the path; we should just report ENOTDIR
            return -20;
          }
          throw e;
        }
        HEAP32[((buf)>>2)]=stat.dev;
        HEAP32[(((buf)+(4))>>2)]=0;
        HEAP32[(((buf)+(8))>>2)]=stat.ino;
        HEAP32[(((buf)+(12))>>2)]=stat.mode;
        HEAP32[(((buf)+(16))>>2)]=stat.nlink;
        HEAP32[(((buf)+(20))>>2)]=stat.uid;
        HEAP32[(((buf)+(24))>>2)]=stat.gid;
        HEAP32[(((buf)+(28))>>2)]=stat.rdev;
        HEAP32[(((buf)+(32))>>2)]=0;
        (tempI64 = [stat.size>>>0,(tempDouble=stat.size,(+(Math_abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math_min((+(Math_floor((tempDouble)/4294967296.0))), 4294967295.0))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296.0)))))>>>0) : 0)],HEAP32[(((buf)+(40))>>2)]=tempI64[0],HEAP32[(((buf)+(44))>>2)]=tempI64[1]);
        HEAP32[(((buf)+(48))>>2)]=4096;
        HEAP32[(((buf)+(52))>>2)]=stat.blocks;
        HEAP32[(((buf)+(56))>>2)]=(stat.atime.getTime() / 1000)|0;
        HEAP32[(((buf)+(60))>>2)]=0;
        HEAP32[(((buf)+(64))>>2)]=(stat.mtime.getTime() / 1000)|0;
        HEAP32[(((buf)+(68))>>2)]=0;
        HEAP32[(((buf)+(72))>>2)]=(stat.ctime.getTime() / 1000)|0;
        HEAP32[(((buf)+(76))>>2)]=0;
        (tempI64 = [stat.ino>>>0,(tempDouble=stat.ino,(+(Math_abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math_min((+(Math_floor((tempDouble)/4294967296.0))), 4294967295.0))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296.0)))))>>>0) : 0)],HEAP32[(((buf)+(80))>>2)]=tempI64[0],HEAP32[(((buf)+(84))>>2)]=tempI64[1]);
        return 0;
      },doMsync:function(addr, stream, len, flags) {
        var buffer = new Uint8Array(HEAPU8.subarray(addr, addr + len));
        FS.msync(stream, buffer, 0, len, flags);
      },doMkdir:function(path, mode) {
        // remove a trailing slash, if one - /a/b/ has basename of '', but
        // we want to create b in the context of this function
        path = PATH.normalize(path);
        if (path[path.length-1] === '/') path = path.substr(0, path.length-1);
        FS.mkdir(path, mode, 0);
        return 0;
      },doMknod:function(path, mode, dev) {
        // we don't want this in the JS API as it uses mknod to create all nodes.
        switch (mode & 61440) {
          case 32768:
          case 8192:
          case 24576:
          case 4096:
          case 49152:
            break;
          default: return -22;
        }
        FS.mknod(path, mode, dev);
        return 0;
      },doReadlink:function(path, buf, bufsize) {
        if (bufsize <= 0) return -22;
        var ret = FS.readlink(path);
  
        var len = Math.min(bufsize, lengthBytesUTF8(ret));
        var endChar = HEAP8[buf+len];
        stringToUTF8(ret, buf, bufsize+1);
        // readlink is one of the rare functions that write out a C string, but does never append a null to the output buffer(!)
        // stringToUTF8() always appends a null byte, so restore the character under the null byte after the write.
        HEAP8[buf+len] = endChar;
  
        return len;
      },doAccess:function(path, amode) {
        if (amode & ~7) {
          // need a valid mode
          return -22;
        }
        var node;
        var lookup = FS.lookupPath(path, { follow: true });
        node = lookup.node;
        if (!node) {
          return -2;
        }
        var perms = '';
        if (amode & 4) perms += 'r';
        if (amode & 2) perms += 'w';
        if (amode & 1) perms += 'x';
        if (perms /* otherwise, they've just passed F_OK */ && FS.nodePermissions(node, perms)) {
          return -13;
        }
        return 0;
      },doDup:function(path, flags, suggestFD) {
        var suggest = FS.getStream(suggestFD);
        if (suggest) FS.close(suggest);
        return FS.open(path, flags, 0, suggestFD, suggestFD).fd;
      },doReadv:function(stream, iov, iovcnt, offset) {
        var ret = 0;
        for (var i = 0; i < iovcnt; i++) {
          var ptr = HEAP32[(((iov)+(i*8))>>2)];
          var len = HEAP32[(((iov)+(i*8 + 4))>>2)];
          var curr = FS.read(stream, HEAP8,ptr, len, offset);
          if (curr < 0) return -1;
          ret += curr;
          if (curr < len) break; // nothing more to read
        }
        return ret;
      },doWritev:function(stream, iov, iovcnt, offset) {
        var ret = 0;
        for (var i = 0; i < iovcnt; i++) {
          var ptr = HEAP32[(((iov)+(i*8))>>2)];
          var len = HEAP32[(((iov)+(i*8 + 4))>>2)];
          var curr = FS.write(stream, HEAP8,ptr, len, offset);
          if (curr < 0) return -1;
          ret += curr;
        }
        return ret;
      },varargs:0,get:function(varargs) {
        SYSCALLS.varargs += 4;
        var ret = HEAP32[(((SYSCALLS.varargs)-(4))>>2)];
        return ret;
      },getStr:function() {
        var ret = UTF8ToString(SYSCALLS.get());
        return ret;
      },getStreamFromFD:function() {
        var stream = FS.getStream(SYSCALLS.get());
        if (!stream) throw new FS.ErrnoError(9);
        return stream;
      },get64:function() {
        var low = SYSCALLS.get(), high = SYSCALLS.get();
        if (low >= 0) assert(high === 0);
        else assert(high === -1);
        return low;
      },getZero:function() {
        assert(SYSCALLS.get() === 0);
      }};function ___syscall140(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // llseek
      var stream = SYSCALLS.getStreamFromFD(), offset_high = SYSCALLS.get(), offset_low = SYSCALLS.get(), result = SYSCALLS.get(), whence = SYSCALLS.get();
      var HIGH_OFFSET = 0x100000000; // 2^32
      // use an unsigned operator on low and shift high by 32-bits
      var offset = offset_high * HIGH_OFFSET + (offset_low >>> 0);
  
      var DOUBLE_LIMIT = 0x20000000000000; // 2^53
      // we also check for equality since DOUBLE_LIMIT + 1 == DOUBLE_LIMIT
      if (offset <= -DOUBLE_LIMIT || offset >= DOUBLE_LIMIT) {
        return -75;
      }
  
      FS.llseek(stream, offset, whence);
      (tempI64 = [stream.position>>>0,(tempDouble=stream.position,(+(Math_abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math_min((+(Math_floor((tempDouble)/4294967296.0))), 4294967295.0))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296.0)))))>>>0) : 0)],HEAP32[((result)>>2)]=tempI64[0],HEAP32[(((result)+(4))>>2)]=tempI64[1]);
      if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null; // reset readdir state
      return 0;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall195(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // SYS_stat64
      var path = SYSCALLS.getStr(), buf = SYSCALLS.get();
      return SYSCALLS.doStat(FS.stat, path, buf);
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall197(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // SYS_fstat64
      var stream = SYSCALLS.getStreamFromFD(), buf = SYSCALLS.get();
      return SYSCALLS.doStat(FS.stat, stream.path, buf);
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall221(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // fcntl64
      var stream = SYSCALLS.getStreamFromFD(), cmd = SYSCALLS.get();
      switch (cmd) {
        case 0: {
          var arg = SYSCALLS.get();
          if (arg < 0) {
            return -22;
          }
          var newStream;
          newStream = FS.open(stream.path, stream.flags, 0, arg);
          return newStream.fd;
        }
        case 1:
        case 2:
          return 0;  // FD_CLOEXEC makes no sense for a single process.
        case 3:
          return stream.flags;
        case 4: {
          var arg = SYSCALLS.get();
          stream.flags |= arg;
          return 0;
        }
        case 12:
        /* case 12: Currently in musl F_GETLK64 has same value as F_GETLK, so omitted to avoid duplicate case blocks. If that changes, uncomment this */ {
          
          var arg = SYSCALLS.get();
          var offset = 0;
          // We're always unlocked.
          HEAP16[(((arg)+(offset))>>1)]=2;
          return 0;
        }
        case 13:
        case 14:
        /* case 13: Currently in musl F_SETLK64 has same value as F_SETLK, so omitted to avoid duplicate case blocks. If that changes, uncomment this */
        /* case 14: Currently in musl F_SETLKW64 has same value as F_SETLKW, so omitted to avoid duplicate case blocks. If that changes, uncomment this */
          
          
          return 0; // Pretend that the locking is successful.
        case 16:
        case 8:
          return -22; // These are for sockets. We don't have them fully implemented yet.
        case 9:
          // musl trusts getown return values, due to a bug where they must be, as they overlap with errors. just return -1 here, so fnctl() returns that, and we set errno ourselves.
          ___setErrNo(22);
          return -1;
        default: {
          return -22;
        }
      }
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall3(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // read
      var stream = SYSCALLS.getStreamFromFD(), buf = SYSCALLS.get(), count = SYSCALLS.get();
      return FS.read(stream, HEAP8,buf, count);
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall4(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // write
      var stream = SYSCALLS.getStreamFromFD(), buf = SYSCALLS.get(), count = SYSCALLS.get();
      return FS.write(stream, HEAP8,buf, count);
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall5(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // open
      var pathname = SYSCALLS.getStr(), flags = SYSCALLS.get(), mode = SYSCALLS.get(); // optional TODO
      var stream = FS.open(pathname, flags, mode);
      return stream.fd;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  function ___syscall6(which, varargs) {SYSCALLS.varargs = varargs;
  try {
   // close
      var stream = SYSCALLS.getStreamFromFD();
      FS.close(stream);
      return 0;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }

  
  
   
  
   
  
     

  function ___unlock() {}

  
  function _fd_write(stream, iov, iovcnt, pnum) {try {
  
      stream = FS.getStream(stream);
      if (!stream) throw new FS.ErrnoError(9);
      var num = SYSCALLS.doWritev(stream, iov, iovcnt);
      HEAP32[((pnum)>>2)]=num
      return 0;
    } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno;
  }
  }function ___wasi_fd_write(
  ) {
  return _fd_write.apply(null, arguments)
  }

   

   

  function _emscripten_get_heap_size() {
      return HEAP8.length;
    }

  function _exit(status) {
      // void _exit(int status);
      // http://pubs.opengroup.org/onlinepubs/000095399/functions/exit.html
      exit(status);
    }

  function _gettimeofday(ptr) {
      var now = Date.now();
      HEAP32[((ptr)>>2)]=(now/1000)|0; // seconds
      HEAP32[(((ptr)+(4))>>2)]=((now % 1000)*1000)|0; // microseconds
      return 0;
    }



   


  function _llvm_cttz_i64(l, h) {
      var ret = _llvm_cttz_i32(l);
      if (ret == 32) ret += _llvm_cttz_i32(h);
      return ((setTempRet0(0),ret)|0);
    }

  
  function _emscripten_memcpy_big(dest, src, num) {
      HEAPU8.set(HEAPU8.subarray(src, src+num), dest);
    }
  
   

   

  
  
  function abortOnCannotGrowMemory(requestedSize) {
      abort('Cannot enlarge memory arrays to size ' + requestedSize + ' bytes (OOM). Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value ' + HEAP8.length + ', (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime but prevents some optimizations, (3) set Module.TOTAL_MEMORY to a higher value before the program runs, or (4) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ');
    }function _emscripten_resize_heap(requestedSize) {
      abortOnCannotGrowMemory(requestedSize);
    } 
FS.staticInit();;
if (ENVIRONMENT_HAS_NODE) { var fs = require("fs"); var NODEJS_PATH = require("path"); NODEFS.staticInit(); };
var ASSERTIONS = true;

// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

/** @type {function(string, boolean=, number=)} */
function intArrayFromString(stringy, dontAddNull, length) {
  var len = length > 0 ? length : lengthBytesUTF8(stringy)+1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array;
}

function intArrayToString(array) {
  var ret = [];
  for (var i = 0; i < array.length; i++) {
    var chr = array[i];
    if (chr > 0xFF) {
      if (ASSERTIONS) {
        assert(false, 'Character code ' + chr + ' (' + String.fromCharCode(chr) + ')  at offset ' + i + ' not in 0x00-0xFF.');
      }
      chr &= 0xFF;
    }
    ret.push(String.fromCharCode(chr));
  }
  return ret.join('');
}


// Copied from https://github.com/strophe/strophejs/blob/e06d027/src/polyfills.js#L149

// This code was written by Tyler Akins and has been placed in the
// public domain.  It would be nice if you left this header intact.
// Base64 code from Tyler Akins -- http://rumkin.com

/**
 * Decodes a base64 string.
 * @param {String} input The string to decode.
 */
var decodeBase64 = typeof atob === 'function' ? atob : function (input) {
  var keyStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  var output = '';
  var chr1, chr2, chr3;
  var enc1, enc2, enc3, enc4;
  var i = 0;
  // remove all characters that are not A-Z, a-z, 0-9, +, /, or =
  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, '');
  do {
    enc1 = keyStr.indexOf(input.charAt(i++));
    enc2 = keyStr.indexOf(input.charAt(i++));
    enc3 = keyStr.indexOf(input.charAt(i++));
    enc4 = keyStr.indexOf(input.charAt(i++));

    chr1 = (enc1 << 2) | (enc2 >> 4);
    chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    chr3 = ((enc3 & 3) << 6) | enc4;

    output = output + String.fromCharCode(chr1);

    if (enc3 !== 64) {
      output = output + String.fromCharCode(chr2);
    }
    if (enc4 !== 64) {
      output = output + String.fromCharCode(chr3);
    }
  } while (i < input.length);
  return output;
};

// Converts a string of base64 into a byte array.
// Throws error on invalid input.
function intArrayFromBase64(s) {
  if (typeof ENVIRONMENT_IS_NODE === 'boolean' && ENVIRONMENT_IS_NODE) {
    var buf;
    try {
      buf = Buffer.from(s, 'base64');
    } catch (_) {
      buf = new Buffer(s, 'base64');
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  try {
    var decoded = decodeBase64(s);
    var bytes = new Uint8Array(decoded.length);
    for (var i = 0 ; i < decoded.length ; ++i) {
      bytes[i] = decoded.charCodeAt(i);
    }
    return bytes;
  } catch (_) {
    throw new Error('Converting base64 string to bytes failed.');
  }
}

// If filename is a base64 data URI, parses and returns data (Buffer on node,
// Uint8Array otherwise). If filename is not a base64 data URI, returns undefined.
function tryParseAsDataURI(filename) {
  if (!isDataURI(filename)) {
    return;
  }

  return intArrayFromBase64(filename.slice(dataURIPrefix.length));
}


// ASM_LIBRARY EXTERN PRIMITIVES: Math_imul,Math_clz32,Int8Array,Int32Array

function nullFunc_ii(x) { abortFnPtrError(x, 'ii'); }
function nullFunc_iidiiii(x) { abortFnPtrError(x, 'iidiiii'); }
function nullFunc_iiii(x) { abortFnPtrError(x, 'iiii'); }
function nullFunc_iiiii(x) { abortFnPtrError(x, 'iiiii'); }
function nullFunc_vii(x) { abortFnPtrError(x, 'vii'); }

var asmGlobalArg = { "Math": Math, "Int8Array": Int8Array, "Int16Array": Int16Array, "Int32Array": Int32Array, "Uint8Array": Uint8Array, "Uint16Array": Uint16Array, "Float32Array": Float32Array, "Float64Array": Float64Array };

var asmLibraryArg = {
  "abort": abort,
  "setTempRet0": setTempRet0,
  "getTempRet0": getTempRet0,
  "abortStackOverflow": abortStackOverflow,
  "nullFunc_ii": nullFunc_ii,
  "nullFunc_iidiiii": nullFunc_iidiiii,
  "nullFunc_iiii": nullFunc_iiii,
  "nullFunc_iiiii": nullFunc_iiiii,
  "nullFunc_vii": nullFunc_vii,
  "___lock": ___lock,
  "___setErrNo": ___setErrNo,
  "___syscall140": ___syscall140,
  "___syscall195": ___syscall195,
  "___syscall197": ___syscall197,
  "___syscall221": ___syscall221,
  "___syscall3": ___syscall3,
  "___syscall4": ___syscall4,
  "___syscall5": ___syscall5,
  "___syscall6": ___syscall6,
  "___unlock": ___unlock,
  "___wasi_fd_write": ___wasi_fd_write,
  "_emscripten_get_heap_size": _emscripten_get_heap_size,
  "_emscripten_memcpy_big": _emscripten_memcpy_big,
  "_emscripten_resize_heap": _emscripten_resize_heap,
  "_exit": _exit,
  "_fd_write": _fd_write,
  "_gettimeofday": _gettimeofday,
  "_llvm_cttz_i64": _llvm_cttz_i64,
  "abortOnCannotGrowMemory": abortOnCannotGrowMemory,
  "demangle": demangle,
  "demangleAll": demangleAll,
  "jsStackTrace": jsStackTrace,
  "stackTrace": stackTrace,
  "tempDoublePtr": tempDoublePtr,
  "DYNAMICTOP_PTR": DYNAMICTOP_PTR
};
// EMSCRIPTEN_START_ASM
var asm = (/** @suppress {uselessCode} */ function(global, env, buffer) {
'almost asm';

  var HEAP8 = new global.Int8Array(buffer),
  HEAP16 = new global.Int16Array(buffer),
  HEAP32 = new global.Int32Array(buffer),
  HEAPU8 = new global.Uint8Array(buffer),
  HEAPU16 = new global.Uint16Array(buffer),
  HEAPF32 = new global.Float32Array(buffer),
  HEAPF64 = new global.Float64Array(buffer),
  tempDoublePtr=env.tempDoublePtr|0,
  DYNAMICTOP_PTR=env.DYNAMICTOP_PTR|0,
  __THREW__ = 0,
  threwValue = 0,
  setjmpId = 0,
  tempInt = 0,
  tempBigInt = 0,
  tempBigIntS = 0,
  tempValue = 0,
  tempDouble = 0.0,
  Math_imul=global.Math.imul,
  Math_clz32=global.Math.clz32,
  abort=env.abort,
  setTempRet0=env.setTempRet0,
  getTempRet0=env.getTempRet0,
  abortStackOverflow=env.abortStackOverflow,
  nullFunc_ii=env.nullFunc_ii,
  nullFunc_iidiiii=env.nullFunc_iidiiii,
  nullFunc_iiii=env.nullFunc_iiii,
  nullFunc_iiiii=env.nullFunc_iiiii,
  nullFunc_vii=env.nullFunc_vii,
  ___lock=env.___lock,
  ___setErrNo=env.___setErrNo,
  ___syscall140=env.___syscall140,
  ___syscall195=env.___syscall195,
  ___syscall197=env.___syscall197,
  ___syscall221=env.___syscall221,
  ___syscall3=env.___syscall3,
  ___syscall4=env.___syscall4,
  ___syscall5=env.___syscall5,
  ___syscall6=env.___syscall6,
  ___unlock=env.___unlock,
  ___wasi_fd_write=env.___wasi_fd_write,
  _emscripten_get_heap_size=env._emscripten_get_heap_size,
  _emscripten_memcpy_big=env._emscripten_memcpy_big,
  _emscripten_resize_heap=env._emscripten_resize_heap,
  _exit=env._exit,
  _fd_write=env._fd_write,
  _gettimeofday=env._gettimeofday,
  _llvm_cttz_i64=env._llvm_cttz_i64,
  abortOnCannotGrowMemory=env.abortOnCannotGrowMemory,
  demangle=env.demangle,
  demangleAll=env.demangleAll,
  jsStackTrace=env.jsStackTrace,
  stackTrace=env.stackTrace,
  STACKTOP = 10064,
  STACK_MAX = 5252944,
  tempFloat = 0.0;

// EMSCRIPTEN_START_FUNCS

function stackAlloc(size) {
  size = size|0;
  var ret = 0;
  ret = STACKTOP;
  STACKTOP = (STACKTOP + size)|0;
  STACKTOP = (STACKTOP + 15)&-16;
    if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(size|0);

  return ret|0;
}
function stackSave() {
  return STACKTOP|0;
}
function stackRestore(top) {
  top = top|0;
  STACKTOP = top;
}
function establishStackSpace(stackBase, stackMax) {
  stackBase = stackBase|0;
  stackMax = stackMax|0;
  STACKTOP = stackBase;
  STACK_MAX = stackMax;
}

function _usage($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $vararg_buffer = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $2 = HEAP32[1852]|0;
 $3 = HEAP32[$1>>2]|0;
 HEAP32[$vararg_buffer>>2] = $3;
 (_fprintf($2,7660,$vararg_buffer)|0);
 STACKTOP = sp;return;
}
function _main($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0167 = 0, $$0168204 = 0, $$0169203 = 0, $$0171202 = 0, $$0175$ph = 0, $$0176 = 0, $$0178 = 0, $$0179 = 0, $$0181 = 0, $$0183 = 0, $$0184 = 0, $$0185 = 0, $$0201 = 0, $$1 = 0, $$1170 = 0, $$1172 = 0, $$1177 = 0, $$1182 = 0, $$2 = 0, $$3 = 0;
 var $$pre = 0, $$pre219 = 0, $10 = 0, $100 = 0, $101 = 0.0, $102 = 0, $103 = 0, $104 = 0.0, $105 = 0.0, $106 = 0.0, $107 = 0.0, $108 = 0.0, $109 = 0.0, $11 = 0, $110 = 0.0, $111 = 0.0, $112 = 0.0, $113 = 0, $114 = 0, $115 = 0;
 var $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0;
 var $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0;
 var $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0;
 var $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0;
 var $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0.0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0;
 var $96 = 0, $97 = 0, $98 = 0, $99 = 0, $or$cond = 0, $or$cond186 = 0, $or$cond209 = 0, $or$cond3 = 0, $vararg_buffer = 0, $vararg_buffer1 = 0, $vararg_buffer10 = 0, $vararg_buffer12 = 0, $vararg_buffer15 = 0, $vararg_buffer18 = 0, $vararg_buffer21 = 0, $vararg_buffer25 = 0, $vararg_buffer4 = 0, $vararg_buffer7 = 0, $vararg_ptr24 = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 192|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(192|0);
 $vararg_buffer25 = sp + 168|0;
 $vararg_buffer21 = sp + 152|0;
 $vararg_buffer18 = sp + 144|0;
 $vararg_buffer15 = sp + 136|0;
 $vararg_buffer12 = sp + 128|0;
 $vararg_buffer10 = sp + 120|0;
 $vararg_buffer7 = sp + 112|0;
 $vararg_buffer4 = sp + 104|0;
 $vararg_buffer1 = sp + 96|0;
 $vararg_buffer = sp + 88|0;
 $2 = sp + 176|0;
 $3 = sp + 172|0;
 $4 = sp;
 HEAP32[$2>>2] = 0;
 HEAP32[$3>>2] = 0;
 $5 = ($0|0)>(1);
 do {
  if ($5) {
   $$0168204 = -1;$$0169203 = 0;$$0171202 = 1;
   while(1) {
    $7 = (($$0171202) + 1)|0;
    $8 = (($1) + ($$0171202<<2)|0);
    $9 = HEAP32[$8>>2]|0;
    $10 = (_strcmp($9,7730)|0);
    $11 = ($10|0)==(0);
    if ($11) {
     label = 5;
     break;
    }
    $12 = (_strcmp($9,7733)|0);
    $13 = ($12|0)==(0);
    if ($13) {
     $14 = (($$0169203) + 1)|0;
     $$1 = $$0168204;$$1170 = $14;$$1172 = $7;
    } else {
     $15 = (_strcmp($9,7736)|0);
     $16 = ($15|0)==(0);
     if ($16) {
      $$1 = 0;$$1170 = $$0169203;$$1172 = $7;
     } else {
      $17 = (_strcmp($9,7744)|0);
      $18 = ($17|0)==(0);
      if ($18) {
       $$1 = 1;$$1170 = $$0169203;$$1172 = $7;
      } else {
       $19 = (_strcmp($9,7752)|0);
       $20 = ($19|0)==(0);
       $21 = HEAP32[$2>>2]|0;
       $22 = ($21|0)==(0|0);
       $or$cond = $20 & $22;
       if ($or$cond) {
        $$0175$ph = $2;
       } else {
        $23 = (_strcmp($9,7755)|0);
        $24 = ($23|0)==(0);
        $25 = HEAP32[$3>>2]|0;
        $26 = ($25|0)==(0|0);
        $or$cond3 = $24 & $26;
        if ($or$cond3) {
         $$0175$ph = $3;
        } else {
         label = 15;
         break;
        }
       }
       $27 = ($7|0)==($0|0);
       if ($27) {
        label = 13;
        break;
       }
       $29 = (($$0171202) + 2)|0;
       $30 = (($1) + ($7<<2)|0);
       $31 = HEAP32[$30>>2]|0;
       HEAP32[$$0175$ph>>2] = $31;
       $$1 = $$0168204;$$1170 = $$0169203;$$1172 = $29;
      }
     }
    }
    $33 = ($$1172|0)<($0|0);
    if ($33) {
     $$0168204 = $$1;$$0169203 = $$1170;$$0171202 = $$1172;
    } else {
     label = 3;
     break;
    }
   }
   if ((label|0) == 3) {
    $6 = ($$1|0)<(0);
    if ($6) {
     break;
    }
    $35 = ($$1170|0)>(0);
    if ($35) {
     switch ($$1|0) {
     case 0:  {
      $36 = HEAP32[1852]|0;
      (_fwrite(7844,13,1,$36)|0);
      $41 = $36;
      break;
     }
     case 1:  {
      $37 = HEAP32[1852]|0;
      (_fwrite(7858,13,1,$37)|0);
      $41 = $37;
      break;
     }
     default: {
      $$pre = HEAP32[1852]|0;
      $41 = $$pre;
     }
     }
     $38 = HEAP32[$2>>2]|0;
     $39 = ($38|0)==(0|0);
     $40 = $39 ? 7872 : $38;
     HEAP32[$vararg_buffer4>>2] = $40;
     (_fprintf($41,7878,$vararg_buffer4)|0);
     $42 = HEAP32[$3>>2]|0;
     $43 = ($42|0)==(0|0);
     $44 = $43 ? 7889 : $42;
     HEAP32[$vararg_buffer7>>2] = $44;
     (_fprintf($41,7896,$vararg_buffer7)|0);
     $46 = $38;
    } else {
     $$pre219 = HEAP32[$2>>2]|0;
     $46 = $$pre219;
    }
    $45 = ($46|0)==(0|0);
    do {
     if ($45) {
      $$0176 = 1048576;$$0185 = 0;
     } else {
      $47 = (_open($46,0,$vararg_buffer10)|0);
      $48 = ($47|0)<(0);
      if ($48) {
       _perror($46);
       _exit(1);
       // unreachable;
      }
      $49 = (_fstat($47,$4)|0);
      $50 = ($49|0)==(0);
      if (!($50)) {
       _perror($46);
       _exit(1);
       // unreachable;
      }
      $51 = ((($4)) + 40|0);
      $52 = $51;
      $53 = $52;
      $54 = HEAP32[$53>>2]|0;
      $55 = (($52) + 4)|0;
      $56 = $55;
      $57 = HEAP32[$56>>2]|0;
      $58 = ($57|0)>(0);
      $59 = ($54>>>0)>(4294967295);
      $60 = ($57|0)==(0);
      $61 = $60 & $59;
      $62 = $58 | $61;
      if ($62) {
       $63 = HEAP32[1852]|0;
       (_fwrite(7908,18,1,$63)|0);
       _exit(1);
       // unreachable;
      } else {
       $$0176 = $54;$$0185 = $47;
       break;
      }
     }
    } while(0);
    $64 = (_malloc($$0176)|0);
    $65 = ($64|0)==(0|0);
    if ($65) {
     _perror(7927);
     _exit(1);
     // unreachable;
    }
    $$0179 = 0;$$0181 = $64;$$1177 = $$0176;
    while(1) {
     $66 = ($$0179|0)==($$1177|0);
     if ($66) {
      $67 = ($$0179>>>0)<(104857600);
      $68 = $$0179 << 1;
      $69 = (($$0179) + 104857600)|0;
      $$2 = $67 ? $68 : $69;
      $70 = (_lzfse_reallocf($$0181,$$2)|0);
      $71 = ($70|0)==(0|0);
      if ($71) {
       label = 38;
       break;
      } else {
       $$1182 = $70;$$3 = $$2;
      }
     } else {
      $$1182 = $$0181;$$3 = $$1177;
     }
     $72 = (($$1182) + ($$0179)|0);
     $73 = (($$3) - ($$0179))|0;
     $74 = (_read($$0185,$72,$73)|0);
     $75 = ($74|0)<(0);
     if ($75) {
      label = 40;
      break;
     }
     $76 = ($74|0)==(0);
     $77 = (($74) + ($$0179))|0;
     if ($76) {
      label = 42;
      break;
     } else {
      $$0179 = $77;$$0181 = $$1182;$$1177 = $$3;
     }
    }
    if ((label|0) == 38) {
     _perror(7927);
     _exit(1);
     // unreachable;
    }
    else if ((label|0) == 40) {
     _perror(7934);
     _exit(1);
     // unreachable;
    }
    else if ((label|0) == 42) {
     if (!($45)) {
      (_close($$0185)|0);
     }
     if ($35) {
      $78 = HEAP32[1852]|0;
      HEAP32[$vararg_buffer12>>2] = $77;
      (_fprintf($78,7939,$vararg_buffer12)|0);
     }
     $79 = ($$1|0)==(0);
     $80 = $77 << 2;
     $81 = $79 ? $77 : $80;
     if ($79) {
      $82 = (_lzfse_encode_scratch_size()|0);
      $85 = $82;
     } else {
      $83 = (_lzfse_decode_scratch_size()|0);
      $85 = $83;
     }
     $84 = ($85|0)==(0);
     if ($84) {
      $93 = 0;
     } else {
      $86 = (_malloc($85)|0);
      $87 = ($86|0)==(0|0);
      if ($87) {
       _perror(7927);
       _exit(1);
       // unreachable;
      } else {
       $93 = $86;
      }
     }
     $88 = (_malloc($81)|0);
     $89 = ($88|0)==(0|0);
     if ($89) {
      _perror(7927);
      _exit(1);
      // unreachable;
     }
     $90 = (+_get_time());
     $91 = ($$1|0)==(1);
     $92 = HEAP32[1852]|0;
     $$0178 = $88;$$0184 = $81;
     while(1) {
      if ($79) {
       $94 = (_lzfse_encode_buffer($$0178,$$0184,$$1182,$77,$93)|0);
       $$0183 = $94;
      } else {
       $95 = (_lzfse_decode_buffer($$0178,$$0184,$$1182,$77,$93)|0);
       $$0183 = $95;
      }
      $96 = ($$0183|0)==(0);
      $97 = ($$0183|0)==($$0184|0);
      $or$cond186 = $91 & $97;
      $or$cond209 = $96 | $or$cond186;
      if (!($or$cond209)) {
       break;
      }
      if ($35) {
       (_fwrite(7958,48,1,$92)|0);
      }
      $98 = $$0184 << 1;
      $99 = (_lzfse_reallocf($$0178,$98)|0);
      $100 = ($99|0)==(0|0);
      if ($100) {
       label = 62;
       break;
      } else {
       $$0178 = $99;$$0184 = $98;
      }
     }
     if ((label|0) == 62) {
      _perror(7927);
      _exit(1);
      // unreachable;
     }
     $101 = (+_get_time());
     if ($35) {
      HEAP32[$vararg_buffer15>>2] = $$0183;
      (_fprintf($92,8007,$vararg_buffer15)|0);
      $102 = $79 ? $77 : $$0183;
      $103 = $79 ? $$0183 : $77;
      $104 = (+($102>>>0));
      $105 = (+($103>>>0));
      $106 = $104 / $105;
      HEAPF64[$vararg_buffer18>>3] = $106;
      (_fprintf($92,8027,$vararg_buffer18)|0);
      $107 = $101 - $90;
      $108 = $107 * 1.0E+9;
      $109 = $108 / $104;
      $110 = $104 * 9.765625E-4;
      $111 = $110 * 9.765625E-4;
      $112 = $111 / $107;
      HEAPF64[$vararg_buffer21>>3] = $109;
      $vararg_ptr24 = ((($vararg_buffer21)) + 8|0);
      HEAPF64[$vararg_ptr24>>3] = $112;
      (_fprintf($92,8052,$vararg_buffer21)|0);
     }
     $113 = HEAP32[$3>>2]|0;
     $114 = ($113|0)==(0|0);
     if ($114) {
      $$0167 = 1;
     } else {
      HEAP32[$vararg_buffer25>>2] = 420;
      $115 = (_open($113,577,$vararg_buffer25)|0);
      $116 = ($115|0)<(0);
      if ($116) {
       _perror($113);
       _exit(1);
       // unreachable;
      } else {
       $$0167 = $115;
      }
     }
     $$0201 = 0;
     while(1) {
      $119 = (($$0178) + ($$0201)|0);
      $120 = (($$0183) - ($$0201))|0;
      $121 = (_write($$0167,$119,$120)|0);
      $122 = ($121|0)<(0);
      if ($122) {
       label = 72;
       break;
      }
      $123 = ($121|0)==(0);
      $118 = (($121) + ($$0201))|0;
      if ($123) {
       label = 74;
       break;
      }
      $117 = ($$0183>>>0)>($118>>>0);
      if ($117) {
       $$0201 = $118;
      } else {
       label = 70;
       break;
      }
     }
     if ((label|0) == 70) {
      if (!($114)) {
       (_close($$0167)|0);
      }
      _free($$1182);
      _free($$0178);
      _free($93);
      STACKTOP = sp;return 0;
     }
     else if ((label|0) == 72) {
      _perror(8081);
      _exit(1);
      // unreachable;
     }
     else if ((label|0) == 74) {
      (_fwrite(8087,31,1,$92)|0);
      _exit(1);
      // unreachable;
     }
    }
   }
   else if ((label|0) == 5) {
    _usage(0,$1);
    _exit(0);
    // unreachable;
   }
   else if ((label|0) == 13) {
    _usage(0,$1);
    $28 = HEAP32[1852]|0;
    HEAP32[$vararg_buffer>>2] = $9;
    (_fprintf($28,7758,$vararg_buffer)|0);
    _exit(1);
    // unreachable;
   }
   else if ((label|0) == 15) {
    _usage(0,$1);
    $32 = HEAP32[1852]|0;
    HEAP32[$vararg_buffer1>>2] = $9;
    (_fprintf($32,7787,$vararg_buffer1)|0);
    _exit(1);
    // unreachable;
   }
  }
 } while(0);
 _usage(0,$1);
 $34 = HEAP32[1852]|0;
 (_fwrite(7811,32,1,$34)|0);
 _exit(1);
 // unreachable;
 return (0)|0;
}
function _lzfse_reallocf($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $2 = 0, $3 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = (_realloc($0,$1)|0);
 $3 = ($2|0)==(0|0);
 if ($3) {
  _free($0);
  $$0 = 0;
 } else {
  $$0 = $2;
 }
 return ($$0|0);
}
function _get_time() {
 var $0 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0.0, $5 = 0, $6 = 0, $7 = 0.0, $8 = 0.0, $9 = 0.0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $0 = sp;
 $1 = (_gettimeofday(($0|0),(0|0))|0);
 $2 = ($1|0)==(0);
 if ($2) {
  $3 = HEAP32[$0>>2]|0;
  $4 = (+($3|0));
  $5 = ((($0)) + 4|0);
  $6 = HEAP32[$5>>2]|0;
  $7 = (+($6|0));
  $8 = $7 * 9.9999999999999995E-7;
  $9 = $8 + $4;
  STACKTOP = sp;return (+$9);
 } else {
  _perror(8119);
  _exit(1);
  // unreachable;
 }
 return +(0.0);
}
function _lzfse_encode_scratch_size() {
 var $0 = 0, $1 = 0, $2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $0 = (_lzvn_encode_scratch_size()|0);
 $1 = ($0>>>0)>(684340);
 $2 = $1 ? $0 : 684340;
 return ($2|0);
}
function _lzvn_encode_scratch_size() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 return 524288;
}
function _lzfse_encode_buffer_with_scratch($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$091 = 0, $$091110 = 0, $$293 = 0, $$3 = 0, $$4 = 0, $$sroa$4$0$$0$$sroa_idx = 0, $$sroa$438$0$$sroa_idx = 0, $$sroa$5$0$$sroa_idx = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0;
 var $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0;
 var $42 = 0, $43 = 0, $44 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $or$cond = 0, $or$cond99 = 0, $storemerge = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $5 = ($3>>>0)<(8);
 L1: do {
  if ($5) {
   $$4 = $3;
   label = 15;
  } else {
   $6 = ($3>>>0)<(4096);
   if ($6) {
    $7 = ($1>>>0)<(17);
    if ($7) {
     $$4 = $3;
     label = 15;
     break;
    }
    $8 = ((($0)) + 12|0);
    $9 = (($1) + -16)|0;
    $10 = (_lzvn_encode_buffer($8,$9,$2,$3,$4)|0);
    $11 = ($10|0)!=(0);
    $12 = ($10>>>0)<($3>>>0);
    $or$cond99 = $11 & $12;
    if (!($or$cond99)) {
     $$4 = $3;
     label = 15;
     break;
    }
    $13 = (($10) + 16)|0;
    $14 = (($8) + ($10)|0);
    $$sroa$5$0$$sroa_idx = ((($0)) + 8|0);
    $$sroa$438$0$$sroa_idx = ((($0)) + 4|0);
    HEAP8[$0>>0]=1853388386&255;HEAP8[$0+1>>0]=(1853388386>>8)&255;HEAP8[$0+2>>0]=(1853388386>>16)&255;HEAP8[$0+3>>0]=1853388386>>24;
    HEAP8[$$sroa$438$0$$sroa_idx>>0]=$3&255;HEAP8[$$sroa$438$0$$sroa_idx+1>>0]=($3>>8)&255;HEAP8[$$sroa$438$0$$sroa_idx+2>>0]=($3>>16)&255;HEAP8[$$sroa$438$0$$sroa_idx+3>>0]=$3>>24;
    HEAP8[$$sroa$5$0$$sroa_idx>>0]=$10&255;HEAP8[$$sroa$5$0$$sroa_idx+1>>0]=($10>>8)&255;HEAP8[$$sroa$5$0$$sroa_idx+2>>0]=($10>>16)&255;HEAP8[$$sroa$5$0$$sroa_idx+3>>0]=$10>>24;
    HEAP8[$14>>0]=611874402&255;HEAP8[$14+1>>0]=(611874402>>8)&255;HEAP8[$14+2>>0]=(611874402>>16)&255;HEAP8[$14+3>>0]=611874402>>24;
    $$3 = $13;
    break;
   }
   _memset(($4|0),0,684340)|0;
   $15 = (_lzfse_encode_init($4)|0);
   $16 = ($15|0)==(0);
   if ($16) {
    $17 = ((($4)) + 20|0);
    HEAP32[$17>>2] = $0;
    $18 = ((($4)) + 24|0);
    HEAP32[$18>>2] = $0;
    $19 = (($0) + ($1)|0);
    $20 = ((($4)) + 28|0);
    HEAP32[$20>>2] = $19;
    HEAP32[$4>>2] = $2;
    $21 = ((($4)) + 12|0);
    HEAP32[$21>>2] = 0;
    $22 = ($3|0)==(-1);
    $23 = ((($4)) + 4|0);
    if ($22) {
     HEAP32[$23>>2] = 262144;
     $24 = (_lzfse_encode_base($4)|0);
     $25 = ($24|0)==(0);
     if (!($25)) {
      $$3 = 0;
      break;
     }
     $$091110 = -262145;
     while(1) {
      HEAP32[$23>>2] = 524288;
      $26 = (_lzfse_encode_base($4)|0);
      $27 = ($26|0)==(0);
      if (!($27)) {
       $$4 = $$091110;
       label = 15;
       break L1;
      }
      (_lzfse_encode_translate($4,262144)|0);
      $$091 = (($$091110) + -262144)|0;
      $28 = ($$091>>>0)>(262143);
      if ($28) {
       $$091110 = $$091;
      } else {
       $$293 = $$091;$storemerge = $$091110;
       break;
      }
     }
    } else {
     $$293 = $3;$storemerge = $3;
    }
    HEAP32[$23>>2] = $storemerge;
    $29 = (_lzfse_encode_base($4)|0);
    $30 = ($29|0)==(0);
    if ($30) {
     $31 = (_lzfse_encode_finish($4)|0);
     $32 = ($31|0)==(0);
     if ($32) {
      $33 = HEAP32[$17>>2]|0;
      $34 = $0;
      $35 = (($33) - ($34))|0;
      $$3 = $35;
     } else {
      $$4 = $$293;
      label = 15;
     }
    } else {
     $$4 = $$293;
     label = 15;
    }
   } else {
    $$4 = $3;
    label = 15;
   }
  }
 } while(0);
 if ((label|0) == 15) {
  $36 = (($3) + 12)|0;
  $37 = ($36>>>0)<=($1>>>0);
  $38 = ($3>>>0)<(2147483647);
  $or$cond = $38 & $37;
  $39 = ((($0)) + 8|0);
  $40 = (($39) + ($3)|0);
  if ($or$cond) {
   $41 = ((($40)) + 4|0);
   $42 = $41;
   $43 = $0;
   $44 = (($42) - ($43))|0;
   $$sroa$4$0$$0$$sroa_idx = ((($0)) + 4|0);
   HEAP8[$0>>0]=762869346&255;HEAP8[$0+1>>0]=(762869346>>8)&255;HEAP8[$0+2>>0]=(762869346>>16)&255;HEAP8[$0+3>>0]=762869346>>24;
   HEAP8[$$sroa$4$0$$0$$sroa_idx>>0]=$$4&255;HEAP8[$$sroa$4$0$$0$$sroa_idx+1>>0]=($$4>>8)&255;HEAP8[$$sroa$4$0$$0$$sroa_idx+2>>0]=($$4>>16)&255;HEAP8[$$sroa$4$0$$0$$sroa_idx+3>>0]=$$4>>24;
   _memcpy(($39|0),($2|0),($3|0))|0;
   HEAP8[$40>>0]=611874402&255;HEAP8[$40+1>>0]=(611874402>>8)&255;HEAP8[$40+2>>0]=(611874402>>16)&255;HEAP8[$40+3>>0]=611874402>>24;
   $$3 = $44;
  } else {
   $$3 = 0;
  }
 }
 return ($$3|0);
}
function _lzvn_encode_buffer($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$ = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $5 = sp;
 HEAP32[$5>>2] = 0;
 $6 = (_lzvn_encode_partial($0,$1,$2,$3,$5,$4)|0);
 $7 = HEAP32[$5>>2]|0;
 $8 = ($7|0)==($3|0);
 $$ = $8 ? $6 : 0;
 STACKTOP = sp;return ($$|0);
}
function _lzfse_encode_init($0) {
 $0 = $0|0;
 var $$01214 = 0, $$013 = 0, $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $exitcond = 0, $exitcond15 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 32|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(32|0);
 $1 = sp;
 $$01214 = 0;
 while(1) {
  $2 = (($1) + ($$01214<<2)|0);
  HEAP32[$2>>2] = -1048556;
  $3 = (((($1)) + 16|0) + ($$01214<<2)|0);
  HEAP32[$3>>2] = 0;
  $4 = (($$01214) + 1)|0;
  $exitcond15 = ($4|0)==(4);
  if ($exitcond15) {
   break;
  } else {
   $$01214 = $4;
  }
 }
 $$013 = 0;
 while(1) {
  $7 = (((($0)) + 160052|0) + ($$013<<5)|0);
  ;HEAP32[$7>>2]=HEAP32[$1>>2]|0;HEAP32[$7+4>>2]=HEAP32[$1+4>>2]|0;HEAP32[$7+8>>2]=HEAP32[$1+8>>2]|0;HEAP32[$7+12>>2]=HEAP32[$1+12>>2]|0;HEAP32[$7+16>>2]=HEAP32[$1+16>>2]|0;HEAP32[$7+20>>2]=HEAP32[$1+20>>2]|0;HEAP32[$7+24>>2]=HEAP32[$1+24>>2]|0;HEAP32[$7+28>>2]=HEAP32[$1+28>>2]|0;
  $8 = (($$013) + 1)|0;
  $exitcond = ($8|0)==(16384);
  if ($exitcond) {
   break;
  } else {
   $$013 = $8;
  }
 }
 $5 = ((($0)) + 32|0);
 ;HEAP32[$5>>2]=0|0;HEAP32[$5+4>>2]=0|0;HEAP32[$5+8>>2]=0|0;
 $6 = ((($0)) + 8|0);
 HEAP32[$6>>2] = 0;
 STACKTOP = sp;return 0;
}
function _lzfse_encode_base($0) {
 $0 = $0|0;
 var $$0$copyload$i = 0, $$0114139 = 0, $$0119140 = 0, $$2116 = 0, $$2116141 = 0, $$2116142 = 0, $$lcssa135 = 0, $$promoted151 = 0, $$promoted155 = 0, $$sink = 0, $$sink212 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0;
 var $107 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0;
 var $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0;
 var $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0;
 var $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0;
 var $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $exitcond = 0, $scevgep = 0;
 var $scevgep179 = 0, $scevgep181 = 0, $spec$select = 0, $spec$select160 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 80|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(80|0);
 $1 = sp + 48|0;
 $2 = sp + 16|0;
 $3 = sp;
 ;HEAP32[$1>>2]=0|0;HEAP32[$1+4>>2]=0|0;HEAP32[$1+8>>2]=0|0;HEAP32[$1+12>>2]=0|0;HEAP32[$1+16>>2]=0|0;HEAP32[$1+20>>2]=0|0;HEAP32[$1+24>>2]=0|0;HEAP32[$1+28>>2]=0|0;
 $4 = ((($0)) + 4|0);
 $5 = HEAP32[$4>>2]|0;
 $6 = (($5) + -8)|0;
 $7 = ((($0)) + 16|0);
 HEAP32[$7>>2] = $6;
 $8 = ((($0)) + 12|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = ($9|0)<($6|0);
 L1: do {
  if ($10) {
   $11 = ((($1)) + 16|0);
   $12 = ((($0)) + 8|0);
   $13 = ((($3)) + 4|0);
   $14 = ((($3)) + 8|0);
   $15 = ((($0)) + 32|0);
   $16 = ((($0)) + 40|0);
   $scevgep = ((($1)) + 4|0);
   $scevgep179 = ((($1)) + 20|0);
   $scevgep181 = ((($2)) + 16|0);
   $$promoted155 = $9;
   L3: while(1) {
    $17 = HEAP32[$0>>2]|0;
    $18 = (($17) + ($$promoted155)|0);
    $$0$copyload$i = HEAPU8[$18>>0]|(HEAPU8[$18+1>>0]<<8)|(HEAPU8[$18+2>>0]<<16)|(HEAPU8[$18+3>>0]<<24);
    $19 = (_hashX($$0$copyload$i)|0);
    $20 = (((($0)) + 160052|0) + ($19<<5)|0);
    ;HEAP32[$2>>2]=HEAP32[$20>>2]|0;HEAP32[$2+4>>2]=HEAP32[$20+4>>2]|0;HEAP32[$2+8>>2]=HEAP32[$20+8>>2]|0;HEAP32[$2+12>>2]=HEAP32[$20+12>>2]|0;HEAP32[$2+16>>2]=HEAP32[$20+16>>2]|0;HEAP32[$2+20>>2]=HEAP32[$20+20>>2]|0;HEAP32[$2+24>>2]=HEAP32[$20+24>>2]|0;HEAP32[$2+28>>2]=HEAP32[$20+28>>2]|0;
    HEAP32[$1>>2] = $$promoted155;
    ;HEAP32[$scevgep>>2]=HEAP32[$20>>2]|0;HEAP32[$scevgep+4>>2]=HEAP32[$20+4>>2]|0;HEAP32[$scevgep+8>>2]=HEAP32[$20+8>>2]|0;
    HEAP32[$11>>2] = $$0$copyload$i;
    ;HEAP32[$scevgep179>>2]=HEAP32[$scevgep181>>2]|0;HEAP32[$scevgep179+4>>2]=HEAP32[$scevgep181+4>>2]|0;HEAP32[$scevgep179+8>>2]=HEAP32[$scevgep181+8>>2]|0;
    $21 = HEAP32[$12>>2]|0;
    $22 = ($$promoted155|0)<($21|0);
    do {
     if (!($22)) {
      HEAP32[$3>>2] = $$promoted155;
      HEAP32[$13>>2] = 0;
      HEAP32[$14>>2] = 0;
      $23 = (-8 - ($$promoted155))|0;
      $$0119140 = 0;$$2116142 = 0;$62 = 0;
      while(1) {
       $25 = (((($2)) + 16|0) + ($$0119140<<2)|0);
       $26 = HEAP32[$25>>2]|0;
       $27 = ($26|0)==($$0$copyload$i|0);
       if ($27) {
        $28 = (($2) + ($$0119140<<2)|0);
        $29 = HEAP32[$28>>2]|0;
        $30 = (($29) + 262139)|0;
        $31 = ($30|0)<($$promoted155|0);
        if ($31) {
         $$2116141 = $$2116142;$$promoted151 = $62;
        } else {
         $32 = (($17) + ($29)|0);
         $33 = HEAP32[$4>>2]|0;
         $34 = (($23) + ($33))|0;
         $35 = ($34>>>0)>(4);
         L12: do {
          if ($35) {
           $$0114139 = 4;
           while(1) {
            $36 = (($32) + ($$0114139)|0);
            $37 = $36;
            $38 = $37;
            $39 = HEAPU8[$38>>0]|(HEAPU8[$38+1>>0]<<8)|(HEAPU8[$38+2>>0]<<16)|(HEAPU8[$38+3>>0]<<24);
            $40 = (($37) + 4)|0;
            $41 = $40;
            $42 = HEAPU8[$41>>0]|(HEAPU8[$41+1>>0]<<8)|(HEAPU8[$41+2>>0]<<16)|(HEAPU8[$41+3>>0]<<24);
            $43 = (($18) + ($$0114139)|0);
            $44 = $43;
            $45 = $44;
            $46 = HEAPU8[$45>>0]|(HEAPU8[$45+1>>0]<<8)|(HEAPU8[$45+2>>0]<<16)|(HEAPU8[$45+3>>0]<<24);
            $47 = (($44) + 4)|0;
            $48 = $47;
            $49 = HEAPU8[$48>>0]|(HEAPU8[$48+1>>0]<<8)|(HEAPU8[$48+2>>0]<<16)|(HEAPU8[$48+3>>0]<<24);
            $50 = $46 ^ $39;
            $51 = $49 ^ $42;
            $52 = ($50|0)==(0);
            $53 = ($51|0)==(0);
            $54 = $52 & $53;
            if (!($54)) {
             break;
            }
            $55 = (($$0114139) + 8)|0;
            $56 = ($55>>>0)<($34>>>0);
            if ($56) {
             $$0114139 = $55;
            } else {
             $$2116 = $55;
             break L12;
            }
           }
           $57 = (_llvm_cttz_i64(($50|0),($51|0),0)|0);
           $58 = (getTempRet0() | 0);
           $59 = $57 >>> 3;
           $60 = (($59) + ($$0114139))|0;
           $$2116 = $60;
          } else {
           $$2116 = 4;
          }
         } while(0);
         $61 = ($$2116>>>0)>($$2116142>>>0);
         $spec$select = $61 ? $29 : $62;
         $spec$select160 = $61 ? $$2116 : $$2116142;
         $$2116141 = $spec$select160;$$promoted151 = $spec$select;
        }
       } else {
        $$2116141 = $$2116142;$$promoted151 = $62;
       }
       $63 = (($$0119140) + 1)|0;
       $exitcond = ($63|0)==(4);
       if ($exitcond) {
        break;
       } else {
        $$0119140 = $63;$$2116142 = $$2116141;$62 = $$promoted151;
       }
      }
      HEAP32[$14>>2] = $$2116141;
      HEAP32[$13>>2] = $$promoted151;
      $24 = ($$2116141|0)==(0);
      if ($24) {
       $64 = (($$promoted155) - ($21))|0;
       $65 = ($64|0)>(2520);
       if (!($65)) {
        break;
       }
       $66 = HEAP32[$16>>2]|0;
       $67 = ($66|0)==(0);
       if ($67) {
        $70 = (_lzfse_backend_literals($0,315)|0);
        $71 = ($70|0)==(0);
        if ($71) {
         break;
        } else {
         break L3;
        }
       }
       $68 = (_lzfse_backend_match($0,$15)|0);
       $69 = ($68|0)==(0);
       if (!($69)) {
        break L3;
       }
       ;HEAP32[$15>>2]=0|0;HEAP32[$15+4>>2]=0|0;HEAP32[$15+8>>2]=0|0;
       break;
      }
      $72 = ($$2116141>>>0)>(235900);
      if ($72) {
       HEAP32[$14>>2] = 235900;
       $87 = 235900;
      } else {
       $87 = $$2116141;
      }
      $73 = ($$promoted155|0)>($21|0);
      if ($73) {
       $75 = $$promoted151;$80 = $$promoted155;
       while(1) {
        $74 = ($75|0)>(0);
        if (!($74)) {
         $$sink = $80;$$sink212 = $75;
         break;
        }
        $76 = (($75) + -1)|0;
        $77 = (($17) + ($76)|0);
        $78 = HEAP8[$77>>0]|0;
        $79 = (($80) + -1)|0;
        $81 = (($17) + ($79)|0);
        $82 = HEAP8[$81>>0]|0;
        $83 = ($78<<24>>24)==($82<<24>>24);
        if (!($83)) {
         $$sink = $80;$$sink212 = $75;
         break;
        }
        $84 = ($79|0)>($21|0);
        if ($84) {
         $75 = $76;$80 = $79;
        } else {
         $$sink = $79;$$sink212 = $76;
         break;
        }
       }
       HEAP32[$13>>2] = $$sink212;
       HEAP32[$3>>2] = $$sink;
       $$lcssa135 = $$sink;
      } else {
       $$lcssa135 = $$promoted155;
      }
      $85 = (($$promoted155) - ($$lcssa135))|0;
      $86 = (($87) + ($85))|0;
      HEAP32[$14>>2] = $86;
      $88 = ($86>>>0)>(39);
      if ($88) {
       $89 = (_lzfse_backend_match($0,$3)|0);
       $90 = ($89|0)==(0);
       if (!($90)) {
        break L3;
       }
       ;HEAP32[$15>>2]=0|0;HEAP32[$15+4>>2]=0|0;HEAP32[$15+8>>2]=0|0;
       break;
      }
      $91 = HEAP32[$16>>2]|0;
      $92 = ($91|0)==(0);
      if ($92) {
       ;HEAP32[$15>>2]=HEAP32[$3>>2]|0;HEAP32[$15+4>>2]=HEAP32[$3+4>>2]|0;HEAP32[$15+8>>2]=HEAP32[$3+8>>2]|0;
       break;
      }
      $93 = HEAP32[$15>>2]|0;
      $94 = (($93) + ($91))|0;
      $95 = ($94>>>0)>($$lcssa135>>>0);
      if (!($95)) {
       $96 = (_lzfse_backend_match($0,$15)|0);
       $97 = ($96|0)==(0);
       if (!($97)) {
        break L3;
       }
       ;HEAP32[$15>>2]=HEAP32[$3>>2]|0;HEAP32[$15+4>>2]=HEAP32[$3+4>>2]|0;HEAP32[$15+8>>2]=HEAP32[$3+8>>2]|0;
       break;
      }
      $98 = ($86>>>0)>($91>>>0);
      if ($98) {
       $99 = (_lzfse_backend_match($0,$3)|0);
       $100 = ($99|0)==(0);
       if (!($100)) {
        break L3;
       }
      } else {
       $101 = (_lzfse_backend_match($0,$15)|0);
       $102 = ($101|0)==(0);
       if (!($102)) {
        break L3;
       }
      }
      ;HEAP32[$15>>2]=0|0;HEAP32[$15+4>>2]=0|0;HEAP32[$15+8>>2]=0|0;
     }
    } while(0);
    ;HEAP32[$20>>2]=HEAP32[$1>>2]|0;HEAP32[$20+4>>2]=HEAP32[$1+4>>2]|0;HEAP32[$20+8>>2]=HEAP32[$1+8>>2]|0;HEAP32[$20+12>>2]=HEAP32[$1+12>>2]|0;HEAP32[$20+16>>2]=HEAP32[$1+16>>2]|0;HEAP32[$20+20>>2]=HEAP32[$1+20>>2]|0;HEAP32[$20+24>>2]=HEAP32[$1+24>>2]|0;HEAP32[$20+28>>2]=HEAP32[$1+28>>2]|0;
    $103 = HEAP32[$8>>2]|0;
    $104 = (($103) + 1)|0;
    HEAP32[$8>>2] = $104;
    $105 = HEAP32[$7>>2]|0;
    $106 = ($104|0)<($105|0);
    if ($106) {
     $$promoted155 = $104;
    } else {
     $107 = 0;
     break L1;
    }
   }
   $107 = -2;
  } else {
   $107 = 0;
  }
 } while(0);
 STACKTOP = sp;return ($107|0);
}
function _lzfse_encode_translate($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$03941 = 0, $$04042 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0;
 var $27 = 0, $28 = 0, $29 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $exitcond = 0, $exitcond43 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($1|0)==(0);
 if (!($2)) {
  $3 = HEAP32[$0>>2]|0;
  $4 = (($3) + ($1)|0);
  HEAP32[$0>>2] = $4;
  $5 = ((($0)) + 4|0);
  $6 = HEAP32[$5>>2]|0;
  $7 = (($6) - ($1))|0;
  HEAP32[$5>>2] = $7;
  $8 = ((($0)) + 12|0);
  $9 = HEAP32[$8>>2]|0;
  $10 = (($9) - ($1))|0;
  HEAP32[$8>>2] = $10;
  $11 = ((($0)) + 16|0);
  $12 = HEAP32[$11>>2]|0;
  $13 = (($12) - ($1))|0;
  HEAP32[$11>>2] = $13;
  $14 = ((($0)) + 8|0);
  $15 = HEAP32[$14>>2]|0;
  $16 = (($15) - ($1))|0;
  HEAP32[$14>>2] = $16;
  $17 = ((($0)) + 32|0);
  $18 = HEAP32[$17>>2]|0;
  $19 = (($18) - ($1))|0;
  HEAP32[$17>>2] = $19;
  $20 = ((($0)) + 36|0);
  $21 = HEAP32[$20>>2]|0;
  $22 = (($21) - ($1))|0;
  HEAP32[$20>>2] = $22;
  $$04042 = 0;
  while(1) {
   $$03941 = 0;
   while(1) {
    $24 = ((((($0)) + 160052|0) + ($$04042<<5)|0) + ($$03941<<2)|0);
    $25 = HEAP32[$24>>2]|0;
    $26 = (($25) - ($1))|0;
    $27 = ($26|0)>(-1048556);
    $28 = $27 ? $26 : -1048556;
    HEAP32[$24>>2] = $28;
    $29 = (($$03941) + 1)|0;
    $exitcond = ($29|0)==(4);
    if ($exitcond) {
     break;
    } else {
     $$03941 = $29;
    }
   }
   $23 = (($$04042) + 1)|0;
   $exitcond43 = ($23|0)==(16384);
   if ($exitcond43) {
    break;
   } else {
    $$04042 = $23;
   }
  }
 }
 return 0;
}
function _lzfse_encode_finish($0) {
 $0 = $0|0;
 var $$ = 0, $$1 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 32|0);
 $2 = ((($0)) + 40|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = ($3|0)==(0);
 if ($4) {
  label = 4;
 } else {
  $5 = (_lzfse_backend_match($0,$1)|0);
  $6 = ($5|0)==(0);
  if ($6) {
   ;HEAP32[$1>>2]=0|0;HEAP32[$1+4>>2]=0|0;HEAP32[$1+8>>2]=0|0;
   label = 4;
  } else {
   $$1 = -2;
  }
 }
 do {
  if ((label|0) == 4) {
   $7 = ((($0)) + 4|0);
   $8 = HEAP32[$7>>2]|0;
   $9 = ((($0)) + 8|0);
   $10 = HEAP32[$9>>2]|0;
   $11 = (($8) - ($10))|0;
   $12 = ($11|0)>(0);
   if ($12) {
    $13 = (_lzfse_backend_literals($0,$11)|0);
    $14 = ($13|0)==(0);
    if (!($14)) {
     $$1 = -2;
     break;
    }
   }
   $15 = (_lzfse_backend_end_of_stream($0)|0);
   $16 = ($15|0)==(0);
   $$ = $16 ? 0 : -2;
   $$1 = $$;
  }
 } while(0);
 return ($$1|0);
}
function _lzfse_backend_match($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = (_lzfse_push_match($0,$1)|0);
 $3 = ($2|0)==(0);
 if ($3) {
  $$0 = 0;
 } else {
  $4 = (_lzfse_encode_matches($0)|0);
  $5 = ($4|0)==(0);
  if ($5) {
   $6 = (_lzfse_push_match($0,$1)|0);
   $$0 = $6;
  } else {
   $$0 = -2;
  }
 }
 return ($$0|0);
}
function _lzfse_backend_literals($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $2 = sp;
 $3 = ((($0)) + 8|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = (($4) + ($1))|0;
 HEAP32[$2>>2] = $5;
 $6 = (($5) + -1)|0;
 $7 = ((($2)) + 4|0);
 HEAP32[$7>>2] = $6;
 $8 = ((($2)) + 8|0);
 HEAP32[$8>>2] = 0;
 $9 = (_lzfse_backend_match($0,$2)|0);
 STACKTOP = sp;return ($9|0);
}
function _lzfse_backend_end_of_stream($0) {
 $0 = $0|0;
 var $$0 = 0, $1 = 0, $10 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = (_lzfse_encode_matches($0)|0);
 $2 = ($1|0)==(0);
 if ($2) {
  $3 = ((($0)) + 20|0);
  $4 = HEAP32[$3>>2]|0;
  $5 = ((($4)) + 4|0);
  $6 = ((($0)) + 28|0);
  $7 = HEAP32[$6>>2]|0;
  $8 = ($5>>>0)>($7>>>0);
  if ($8) {
   $$0 = -2;
  } else {
   HEAP8[$4>>0]=611874402&255;HEAP8[$4+1>>0]=(611874402>>8)&255;HEAP8[$4+2>>0]=(611874402>>16)&255;HEAP8[$4+3>>0]=611874402>>24;
   $9 = HEAP32[$3>>2]|0;
   $10 = ((($9)) + 4|0);
   HEAP32[$3>>2] = $10;
   $$0 = 0;
  }
 } else {
  $$0 = -2;
 }
 return ($$0|0);
}
function _lzfse_encode_matches($0) {
 $0 = $0|0;
 var $$0 = 0, $$0182383 = 0, $$0183382 = 0, $$0187440 = 0, $$0189439 = 0, $$0190$lcssa469470 = 0, $$0190434 = 0, $$0191$lcssa471 = 0, $$0191428 = 0, $$0192433 = 0, $$0193427 = 0, $$0194423 = 0, $$0195418 = 0, $$0196406 = 0, $$0199390 = 0, $$0356$lcssa = 0, $$0356388 = 0, $$0357$lcssa = 0, $$0357387 = 0, $$0358$lcssa = 0;
 var $$0358386 = 0, $$0359$lcssa = 0, $$0359404 = 0, $$0360$lcssa = 0, $$0360403 = 0, $$0361$lcssa = 0, $$0361402 = 0, $$0362$lcssa = 0, $$0362401 = 0, $$1 = 0, $$1184 = 0, $$1188 = 0, $$lcssa = 0, $$lcssa380 = 0, $$pre = 0, $$pre468 = 0, $$sroa$0$0$$sroa_idx$i = 0, $$sroa$0$0$$sroa_idx$i200 = 0, $$sroa$0$0$$sroa_idx$i210 = 0, $$sroa$0$0$$sroa_idx$i220 = 0;
 var $$sroa$0$0$$sroa_idx$i230 = 0, $$sroa$0$0$$sroa_idx$i240 = 0, $$sroa$0$0$$sroa_idx$i250 = 0, $$sroa$0$0$copyload$i = 0, $$sroa$0$0$copyload$i201 = 0, $$sroa$0$0$copyload$i211 = 0, $$sroa$0$0$copyload$i221 = 0, $$sroa$0$0$copyload$i231 = 0, $$sroa$0$0$copyload$i241 = 0, $$sroa$0$0$copyload$i251 = 0, $$sroa$0$0$in$lcssa = 0, $$sroa$0$0$in389 = 0, $$sroa$0281$0$lcssa = 0, $$sroa$0281$0385 = 0, $$sroa$0310$0$lcssa = 0, $$sroa$0310$0405 = 0, $$sroa$0335$0$lcssa = 0, $$sroa$0335$0400 = 0, $$sroa$19$0$lcssa = 0, $$sroa$19$0399 = 0;
 var $$sroa$26$0$lcssa = 0, $$sroa$26$0384 = 0, $$sroa$4$0$$sroa_idx27$i = 0, $$sroa$4$0$$sroa_idx27$i202 = 0, $$sroa$4$0$$sroa_idx27$i212 = 0, $$sroa$4$0$$sroa_idx27$i222 = 0, $$sroa$4$0$$sroa_idx27$i232 = 0, $$sroa$4$0$$sroa_idx27$i242 = 0, $$sroa$4$0$$sroa_idx27$i252 = 0, $$sroa$4$0$copyload$i = 0, $$sroa$4$0$copyload$i203 = 0, $$sroa$4$0$copyload$i213 = 0, $$sroa$4$0$copyload$i223 = 0, $$sroa$4$0$copyload$i233 = 0, $$sroa$4$0$copyload$i243 = 0, $$sroa$4$0$copyload$i253 = 0, $$sroa$5$0$$sroa_idx29$i = 0, $$sroa$5$0$$sroa_idx29$i204 = 0, $$sroa$5$0$$sroa_idx29$i214 = 0, $$sroa$5$0$$sroa_idx29$i224 = 0;
 var $$sroa$5$0$$sroa_idx29$i234 = 0, $$sroa$5$0$$sroa_idx29$i244 = 0, $$sroa$5$0$$sroa_idx29$i254 = 0, $$sroa$5$0$copyload$i = 0, $$sroa$5$0$copyload$i205 = 0, $$sroa$5$0$copyload$i215 = 0, $$sroa$5$0$copyload$i225 = 0, $$sroa$5$0$copyload$i235 = 0, $$sroa$5$0$copyload$i245 = 0, $$sroa$5$0$copyload$i255 = 0, $$sroa$6$0$$sroa_idx31$i = 0, $$sroa$6$0$$sroa_idx31$i206 = 0, $$sroa$6$0$$sroa_idx31$i216 = 0, $$sroa$6$0$$sroa_idx31$i226 = 0, $$sroa$6$0$$sroa_idx31$i236 = 0, $$sroa$6$0$$sroa_idx31$i246 = 0, $$sroa$6$0$$sroa_idx31$i256 = 0, $$sroa$6$0$copyload$i = 0, $$sroa$6$0$copyload$i207 = 0, $$sroa$6$0$copyload$i217 = 0;
 var $$sroa$6$0$copyload$i227 = 0, $$sroa$6$0$copyload$i237 = 0, $$sroa$6$0$copyload$i247 = 0, $$sroa$6$0$copyload$i257 = 0, $$v$i = 0, $$v$i209 = 0, $$v$i219 = 0, $$v$i229 = 0, $$v$i239 = 0, $$v$i249 = 0, $$v$i259 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0;
 var $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0;
 var $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0;
 var $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0;
 var $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0;
 var $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0, $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0;
 var $198 = 0, $199 = 0, $2 = 0, $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0, $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0;
 var $215 = 0, $216 = 0, $217 = 0, $218 = 0, $219 = 0, $22 = 0, $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0, $226 = 0, $227 = 0, $228 = 0, $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0;
 var $233 = 0, $234 = 0, $235 = 0, $236 = 0, $237 = 0, $238 = 0, $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0, $244 = 0, $245 = 0, $246 = 0, $247 = 0, $248 = 0, $249 = 0, $25 = 0, $250 = 0;
 var $251 = 0, $252 = 0, $253 = 0, $254 = 0, $255 = 0, $256 = 0, $257 = 0, $258 = 0, $259 = 0, $26 = 0, $260 = 0, $261 = 0, $262 = 0, $263 = 0, $264 = 0, $265 = 0, $266 = 0, $267 = 0, $268 = 0, $269 = 0;
 var $27 = 0, $270 = 0, $271 = 0, $272 = 0, $273 = 0, $274 = 0, $275 = 0, $276 = 0, $277 = 0, $278 = 0, $279 = 0, $28 = 0, $280 = 0, $281 = 0, $282 = 0, $283 = 0, $284 = 0, $285 = 0, $286 = 0, $287 = 0;
 var $288 = 0, $289 = 0, $29 = 0, $290 = 0, $291 = 0, $292 = 0, $293 = 0, $294 = 0, $295 = 0, $296 = 0, $297 = 0, $298 = 0, $299 = 0, $3 = 0, $30 = 0, $300 = 0, $301 = 0, $302 = 0, $303 = 0, $304 = 0;
 var $305 = 0, $306 = 0, $307 = 0, $308 = 0, $309 = 0, $31 = 0, $310 = 0, $311 = 0, $312 = 0, $313 = 0, $314 = 0, $315 = 0, $316 = 0, $317 = 0, $318 = 0, $319 = 0, $32 = 0, $320 = 0, $321 = 0, $322 = 0;
 var $323 = 0, $324 = 0, $325 = 0, $326 = 0, $327 = 0, $328 = 0, $329 = 0, $33 = 0, $330 = 0, $331 = 0, $332 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0;
 var $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0;
 var $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0;
 var $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0;
 var $97 = 0, $98 = 0, $99 = 0, $exitcond = 0, $exitcond466 = 0, $exitcond467 = 0, $not$$i = 0, $not$$i208 = 0, $not$$i218 = 0, $not$$i228 = 0, $not$$i238 = 0, $not$$i248 = 0, $not$$i258 = 0, dest = 0, label = 0, sp = 0, stop = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 5104|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(5104|0);
 $1 = sp + 4240|0;
 $2 = sp + 4160|0;
 $3 = sp + 3904|0;
 $4 = sp + 2880|0;
 $5 = sp + 2720|0;
 $6 = sp + 2560|0;
 $7 = sp + 2048|0;
 $8 = sp;
 $9 = sp + 4320|0;
 $10 = ((($0)) + 48|0);
 $11 = HEAP32[$10>>2]|0;
 $12 = ($11|0)==(0);
 if ($12) {
  $13 = ((($0)) + 44|0);
  $14 = HEAP32[$13>>2]|0;
  $15 = ($14|0)==(0);
  if ($15) {
   $$1 = 0;
  } else {
   label = 3;
  }
 } else {
  label = 3;
 }
 if ((label|0) == 3) {
  _memset(($9|0),0,772)|0;
  $16 = ((($0)) + 20|0);
  $17 = HEAP32[$16>>2]|0;
  $18 = $11 & 3;
  $19 = ($18|0)==(0);
  if (!($19)) {
   $21 = $11;
   while(1) {
    $20 = (($21) + 1)|0;
    HEAP32[$10>>2] = $20;
    $22 = (((($0)) + 120052|0) + ($21)|0);
    HEAP8[$22>>0] = 0;
    $23 = HEAP32[$10>>2]|0;
    $24 = $23 & 3;
    $25 = ($24|0)==(0);
    if ($25) {
     break;
    } else {
     $21 = $23;
    }
   }
  }
  $26 = ((($0)) + 44|0);
  $27 = HEAP32[$26>>2]|0;
  $28 = ($27|0)==(0);
  if ($28) {
   $$lcssa380 = 0;
  } else {
   $$0187440 = 0;$$0189439 = 0;$331 = $27;
   while(1) {
    $30 = (((($0)) + 80052|0) + ($$0189439<<2)|0);
    $31 = HEAP32[$30>>2]|0;
    $32 = ($31|0)==($$0187440|0);
    if ($32) {
     HEAP32[$30>>2] = 0;
     $$pre = HEAP32[$26>>2]|0;
     $$1188 = $$0187440;$35 = $$pre;
    } else {
     $$1188 = $31;$35 = $331;
    }
    $33 = (($$0189439) + 1)|0;
    $34 = ($33>>>0)<($35>>>0);
    if ($34) {
     $$0187440 = $$1188;$$0189439 = $33;$331 = $35;
    } else {
     $$lcssa380 = $35;
     break;
    }
   }
  }
  dest=$1; stop=dest+80|0; do { HEAP32[dest>>2]=0|0; dest=dest+4|0; } while ((dest|0) < (stop|0));
  dest=$2; stop=dest+80|0; do { HEAP32[dest>>2]=0|0; dest=dest+4|0; } while ((dest|0) < (stop|0));
  _memset(($3|0),0,256)|0;
  _memset(($4|0),0,1024)|0;
  $29 = ($$lcssa380|0)==(0);
  if ($29) {
   $$0190$lcssa469470 = 0;$$0191$lcssa471 = 0;
  } else {
   $$0190434 = 0;$$0192433 = 0;
   while(1) {
    $36 = (((($0)) + 52|0) + ($$0192433<<2)|0);
    $37 = HEAP32[$36>>2]|0;
    $38 = (($37) + ($$0190434))|0;
    $39 = (_l_base_from_value($37)|0);
    $40 = $39&255;
    $41 = (($1) + ($40<<2)|0);
    $42 = HEAP32[$41>>2]|0;
    $43 = (($42) + 1)|0;
    HEAP32[$41>>2] = $43;
    $44 = (($$0192433) + 1)|0;
    $exitcond467 = ($44|0)==($$lcssa380|0);
    if ($exitcond467) {
     break;
    } else {
     $$0190434 = $38;$$0192433 = $44;
    }
   }
   if ($29) {
    $$0190$lcssa469470 = $38;$$0191$lcssa471 = 0;
   } else {
    $$0191428 = 0;$$0193427 = 0;
    while(1) {
     $45 = (((($0)) + 40052|0) + ($$0193427<<2)|0);
     $46 = HEAP32[$45>>2]|0;
     $47 = (($46) + ($$0191428))|0;
     $48 = (_m_base_from_value($46)|0);
     $49 = $48&255;
     $50 = (($2) + ($49<<2)|0);
     $51 = HEAP32[$50>>2]|0;
     $52 = (($51) + 1)|0;
     HEAP32[$50>>2] = $52;
     $53 = (($$0193427) + 1)|0;
     $exitcond466 = ($53|0)==($$lcssa380|0);
     if ($exitcond466) {
      break;
     } else {
      $$0191428 = $47;$$0193427 = $53;
     }
    }
    if ($29) {
     $$0190$lcssa469470 = $38;$$0191$lcssa471 = $47;
    } else {
     $$0194423 = 0;
     while(1) {
      $56 = (((($0)) + 80052|0) + ($$0194423<<2)|0);
      $57 = HEAP32[$56>>2]|0;
      $58 = (_d_base_from_value($57)|0);
      $59 = $58&255;
      $60 = (($3) + ($59<<2)|0);
      $61 = HEAP32[$60>>2]|0;
      $62 = (($61) + 1)|0;
      HEAP32[$60>>2] = $62;
      $63 = (($$0194423) + 1)|0;
      $exitcond = ($63|0)==($$lcssa380|0);
      if ($exitcond) {
       $$0190$lcssa469470 = $38;$$0191$lcssa471 = $47;
       break;
      } else {
       $$0194423 = $63;
      }
     }
    }
   }
  }
  $54 = HEAP32[$10>>2]|0;
  $55 = ($54|0)==(0);
  if ($55) {
   $$lcssa = 0;
  } else {
   $$0195418 = 0;
   while(1) {
    $69 = (((($0)) + 120052|0) + ($$0195418)|0);
    $70 = HEAP8[$69>>0]|0;
    $71 = $70&255;
    $72 = (($4) + ($71<<2)|0);
    $73 = HEAP32[$72>>2]|0;
    $74 = (($73) + 1)|0;
    HEAP32[$72>>2] = $74;
    $75 = (($$0195418) + 1)|0;
    $76 = ($75>>>0)<($54>>>0);
    if ($76) {
     $$0195418 = $75;
    } else {
     $$lcssa = $54;
     break;
    }
   }
  }
  $64 = HEAP32[$16>>2]|0;
  $65 = ((($64)) + 752|0);
  $66 = ((($0)) + 28|0);
  $67 = HEAP32[$66>>2]|0;
  $68 = ($65>>>0)>($67>>>0);
  L36: do {
   if ($68) {
    label = 36;
   } else {
    HEAP32[$9>>2] = 829978210;
    $77 = (($$0191$lcssa471) + ($$0190$lcssa469470))|0;
    $78 = ((($9)) + 4|0);
    HEAP32[$78>>2] = $77;
    $79 = ((($9)) + 16|0);
    HEAP32[$79>>2] = $$lcssa380;
    $80 = ((($9)) + 12|0);
    HEAP32[$80>>2] = $$lcssa;
    $81 = ((($9)) + 50|0);
    _fse_normalize_freq(64,20,$1,$81);
    $82 = ((($9)) + 90|0);
    _fse_normalize_freq(64,20,$2,$82);
    $83 = ((($9)) + 130|0);
    _fse_normalize_freq(256,64,$3,$83);
    $84 = ((($9)) + 258|0);
    _fse_normalize_freq(1024,256,$4,$84);
    $85 = (_lzfse_encode_v1_freq_table($64,$9)|0);
    $86 = HEAP32[$16>>2]|0;
    $87 = (($86) + ($85)|0);
    HEAP32[$16>>2] = $87;
    _fse_init_encoder_table(64,20,$81,$5);
    _fse_init_encoder_table(64,20,$82,$6);
    _fse_init_encoder_table(256,64,$83,$7);
    _fse_init_encoder_table(1024,256,$84,$8);
    $88 = HEAP32[$16>>2]|0;
    $89 = HEAP32[$10>>2]|0;
    $90 = ($89|0)==(0);
    if ($90) {
     $$0359$lcssa = 0;$$0360$lcssa = 0;$$0361$lcssa = 0;$$0362$lcssa = 0;$$sroa$0310$0$lcssa = $88;$$sroa$0335$0$lcssa = 0;$$sroa$19$0$lcssa = 0;
    } else {
     $$0196406 = $89;$$0359404 = 0;$$0360403 = 0;$$0361402 = 0;$$0362401 = 0;$$sroa$0310$0405 = $88;$$sroa$0335$0400 = 0;$$sroa$19$0399 = 0;
     while(1) {
      $91 = $$sroa$0310$0405;
      $92 = ((($91)) + 16|0);
      $93 = HEAP32[$66>>2]|0;
      $94 = ($92>>>0)>($93>>>0);
      if ($94) {
       label = 36;
       break L36;
      }
      $95 = (($$0196406) + -4)|0;
      $96 = (($$0196406) + -1)|0;
      $97 = (((($0)) + 120052|0) + ($96)|0);
      $98 = HEAP8[$97>>0]|0;
      $99 = $$0359404 & 65535;
      $100 = $98&255;
      $$sroa$0$0$$sroa_idx$i = (($8) + ($100<<3)|0);
      $$sroa$0$0$copyload$i = HEAP16[$$sroa$0$0$$sroa_idx$i>>1]|0;
      $$sroa$4$0$$sroa_idx27$i = (((($8) + ($100<<3)|0)) + 2|0);
      $$sroa$4$0$copyload$i = HEAP16[$$sroa$4$0$$sroa_idx27$i>>1]|0;
      $$sroa$5$0$$sroa_idx29$i = (((($8) + ($100<<3)|0)) + 4|0);
      $$sroa$5$0$copyload$i = HEAP16[$$sroa$5$0$$sroa_idx29$i>>1]|0;
      $$sroa$6$0$$sroa_idx31$i = (((($8) + ($100<<3)|0)) + 6|0);
      $$sroa$6$0$copyload$i = HEAP16[$$sroa$6$0$$sroa_idx31$i>>1]|0;
      $101 = $$sroa$0$0$copyload$i << 16 >> 16;
      $102 = $$sroa$4$0$copyload$i << 16 >> 16;
      $103 = ($99|0)>=($101|0);
      $not$$i = $103 ^ 1;
      $104 = $not$$i << 31 >> 31;
      $105 = (($104) + ($102))|0;
      $$v$i = $103 ? $$sroa$5$0$copyload$i : $$sroa$6$0$copyload$i;
      $106 = (_fse_mask_lsb32($99,$105)|0);
      $107 = $106 << $$sroa$19$0399;
      $108 = $107 | $$sroa$0335$0400;
      $109 = (($105) + ($$sroa$19$0399))|0;
      $110 = $$v$i&65535;
      $111 = $99 >>> $105;
      $112 = (($111) + ($110))|0;
      $113 = (($$0196406) + -2)|0;
      $114 = (((($0)) + 120052|0) + ($113)|0);
      $115 = HEAP8[$114>>0]|0;
      $116 = $$0360403 & 65535;
      $117 = $115&255;
      $$sroa$0$0$$sroa_idx$i200 = (($8) + ($117<<3)|0);
      $$sroa$0$0$copyload$i201 = HEAP16[$$sroa$0$0$$sroa_idx$i200>>1]|0;
      $$sroa$4$0$$sroa_idx27$i202 = (((($8) + ($117<<3)|0)) + 2|0);
      $$sroa$4$0$copyload$i203 = HEAP16[$$sroa$4$0$$sroa_idx27$i202>>1]|0;
      $$sroa$5$0$$sroa_idx29$i204 = (((($8) + ($117<<3)|0)) + 4|0);
      $$sroa$5$0$copyload$i205 = HEAP16[$$sroa$5$0$$sroa_idx29$i204>>1]|0;
      $$sroa$6$0$$sroa_idx31$i206 = (((($8) + ($117<<3)|0)) + 6|0);
      $$sroa$6$0$copyload$i207 = HEAP16[$$sroa$6$0$$sroa_idx31$i206>>1]|0;
      $118 = $$sroa$0$0$copyload$i201 << 16 >> 16;
      $119 = $$sroa$4$0$copyload$i203 << 16 >> 16;
      $120 = ($116|0)>=($118|0);
      $not$$i208 = $120 ^ 1;
      $121 = $not$$i208 << 31 >> 31;
      $122 = (($121) + ($119))|0;
      $$v$i209 = $120 ? $$sroa$5$0$copyload$i205 : $$sroa$6$0$copyload$i207;
      $123 = (_fse_mask_lsb32($116,$122)|0);
      $124 = $123 << $109;
      $125 = $108 | $124;
      $126 = (($122) + ($109))|0;
      $127 = $$v$i209&65535;
      $128 = $116 >>> $122;
      $129 = (($128) + ($127))|0;
      $130 = $126 & -8;
      $131 = $$sroa$0310$0405;
      HEAP8[$131>>0]=$125&255;HEAP8[$131+1>>0]=($125>>8)&255;HEAP8[$131+2>>0]=($125>>16)&255;HEAP8[$131+3>>0]=$125>>24;
      $132 = $126 >> 3;
      $133 = (($91) + ($132)|0);
      $134 = $125 >>> $130;
      $135 = (($126) - ($130))|0;
      $136 = (($$0196406) + -3)|0;
      $137 = (((($0)) + 120052|0) + ($136)|0);
      $138 = HEAP8[$137>>0]|0;
      $139 = $$0361402 & 65535;
      $140 = $138&255;
      $$sroa$0$0$$sroa_idx$i220 = (($8) + ($140<<3)|0);
      $$sroa$0$0$copyload$i221 = HEAP16[$$sroa$0$0$$sroa_idx$i220>>1]|0;
      $$sroa$4$0$$sroa_idx27$i222 = (((($8) + ($140<<3)|0)) + 2|0);
      $$sroa$4$0$copyload$i223 = HEAP16[$$sroa$4$0$$sroa_idx27$i222>>1]|0;
      $$sroa$5$0$$sroa_idx29$i224 = (((($8) + ($140<<3)|0)) + 4|0);
      $$sroa$5$0$copyload$i225 = HEAP16[$$sroa$5$0$$sroa_idx29$i224>>1]|0;
      $$sroa$6$0$$sroa_idx31$i226 = (((($8) + ($140<<3)|0)) + 6|0);
      $$sroa$6$0$copyload$i227 = HEAP16[$$sroa$6$0$$sroa_idx31$i226>>1]|0;
      $141 = $$sroa$0$0$copyload$i221 << 16 >> 16;
      $142 = $$sroa$4$0$copyload$i223 << 16 >> 16;
      $143 = ($139|0)>=($141|0);
      $not$$i228 = $143 ^ 1;
      $144 = $not$$i228 << 31 >> 31;
      $145 = (($144) + ($142))|0;
      $$v$i229 = $143 ? $$sroa$5$0$copyload$i225 : $$sroa$6$0$copyload$i227;
      $146 = (_fse_mask_lsb32($139,$145)|0);
      $147 = $146 << $135;
      $148 = $147 | $134;
      $149 = (($145) + ($135))|0;
      $150 = $$v$i229&65535;
      $151 = $139 >>> $145;
      $152 = (($151) + ($150))|0;
      $153 = (((($0)) + 120052|0) + ($95)|0);
      $154 = HEAP8[$153>>0]|0;
      $155 = $$0362401 & 65535;
      $156 = $154&255;
      $$sroa$0$0$$sroa_idx$i230 = (($8) + ($156<<3)|0);
      $$sroa$0$0$copyload$i231 = HEAP16[$$sroa$0$0$$sroa_idx$i230>>1]|0;
      $$sroa$4$0$$sroa_idx27$i232 = (((($8) + ($156<<3)|0)) + 2|0);
      $$sroa$4$0$copyload$i233 = HEAP16[$$sroa$4$0$$sroa_idx27$i232>>1]|0;
      $$sroa$5$0$$sroa_idx29$i234 = (((($8) + ($156<<3)|0)) + 4|0);
      $$sroa$5$0$copyload$i235 = HEAP16[$$sroa$5$0$$sroa_idx29$i234>>1]|0;
      $$sroa$6$0$$sroa_idx31$i236 = (((($8) + ($156<<3)|0)) + 6|0);
      $$sroa$6$0$copyload$i237 = HEAP16[$$sroa$6$0$$sroa_idx31$i236>>1]|0;
      $157 = $$sroa$0$0$copyload$i231 << 16 >> 16;
      $158 = $$sroa$4$0$copyload$i233 << 16 >> 16;
      $159 = ($155|0)>=($157|0);
      $not$$i238 = $159 ^ 1;
      $160 = $not$$i238 << 31 >> 31;
      $161 = (($160) + ($158))|0;
      $$v$i239 = $159 ? $$sroa$5$0$copyload$i235 : $$sroa$6$0$copyload$i237;
      $162 = (_fse_mask_lsb32($155,$161)|0);
      $163 = $162 << $149;
      $164 = $148 | $163;
      $165 = (($161) + ($149))|0;
      $166 = $$v$i239&65535;
      $167 = $155 >>> $161;
      $168 = (($167) + ($166))|0;
      $169 = $165 & -8;
      HEAP8[$133>>0]=$164&255;HEAP8[$133+1>>0]=($164>>8)&255;HEAP8[$133+2>>0]=($164>>16)&255;HEAP8[$133+3>>0]=$164>>24;
      $170 = $165 >> 3;
      $171 = (($133) + ($170)|0);
      $172 = $171;
      $173 = $164 >>> $169;
      $174 = (($165) - ($169))|0;
      $175 = ($95|0)==(0);
      if ($175) {
       break;
      } else {
       $$0196406 = $95;$$0359404 = $112;$$0360403 = $129;$$0361402 = $152;$$0362401 = $168;$$sroa$0310$0405 = $172;$$sroa$0335$0400 = $173;$$sroa$19$0399 = $174;
      }
     }
     $176 = $171;
     $177 = $112&65535;
     $178 = $129&65535;
     $179 = $152&65535;
     $180 = $168&65535;
     $$0359$lcssa = $177;$$0360$lcssa = $178;$$0361$lcssa = $179;$$0362$lcssa = $180;$$sroa$0310$0$lcssa = $176;$$sroa$0335$0$lcssa = $173;$$sroa$19$0$lcssa = $174;
    }
    $181 = (($$sroa$19$0$lcssa) + 7)|0;
    $182 = $181 & -8;
    $183 = $$sroa$0310$0$lcssa;
    HEAP8[$183>>0]=$$sroa$0335$0$lcssa&255;HEAP8[$183+1>>0]=($$sroa$0335$0$lcssa>>8)&255;HEAP8[$183+2>>0]=($$sroa$0335$0$lcssa>>16)&255;HEAP8[$183+3>>0]=$$sroa$0335$0$lcssa>>24;
    $184 = $181 >> 3;
    $185 = $$sroa$0310$0$lcssa;
    $186 = (($185) + ($184)|0);
    $187 = $186;
    $188 = (($$sroa$19$0$lcssa) - ($182))|0;
    $189 = ((($9)) + 28|0);
    HEAP32[$189>>2] = $188;
    $190 = HEAP32[$16>>2]|0;
    $191 = (($187) - ($190))|0;
    $192 = ((($9)) + 20|0);
    HEAP32[$192>>2] = $191;
    $193 = ((($9)) + 32|0);
    HEAP16[$193>>1] = $$0362$lcssa;
    $194 = ((($9)) + 34|0);
    HEAP16[$194>>1] = $$0361$lcssa;
    $195 = ((($9)) + 36|0);
    HEAP16[$195>>1] = $$0360$lcssa;
    $196 = ((($9)) + 38|0);
    HEAP16[$196>>1] = $$0359$lcssa;
    HEAP32[$16>>2] = $187;
    $197 = ((($186)) + 8|0);
    $198 = HEAP32[$66>>2]|0;
    $199 = ($197>>>0)>($198>>>0);
    if ($199) {
     label = 36;
    } else {
     $200 = HEAP32[$26>>2]|0;
     $201 = $186;
     $202 = $201;
     HEAP8[$202>>0]=0&255;HEAP8[$202+1>>0]=(0>>8)&255;HEAP8[$202+2>>0]=(0>>16)&255;HEAP8[$202+3>>0]=0>>24;
     $203 = (($201) + 4)|0;
     $204 = $203;
     HEAP8[$204>>0]=0&255;HEAP8[$204+1>>0]=(0>>8)&255;HEAP8[$204+2>>0]=(0>>16)&255;HEAP8[$204+3>>0]=0>>24;
     $205 = ($200|0)==(0);
     if ($205) {
      $$0356$lcssa = 0;$$0357$lcssa = 0;$$0358$lcssa = 0;$$sroa$0$0$in$lcssa = $197;$$sroa$0281$0$lcssa = 0;$$sroa$26$0$lcssa = 0;
     } else {
      $$0199390 = $200;$$0356388 = 0;$$0357387 = 0;$$0358386 = 0;$$sroa$0$0$in389 = $197;$$sroa$0281$0385 = 0;$$sroa$26$0384 = 0;
      while(1) {
       $206 = ((($$sroa$0$0$in389)) + 16|0);
       $207 = HEAP32[$66>>2]|0;
       $208 = ($206>>>0)>($207>>>0);
       if ($208) {
        label = 36;
        break L36;
       }
       $209 = (($$0199390) + -1)|0;
       $210 = (((($0)) + 80052|0) + ($209<<2)|0);
       $211 = HEAP32[$210>>2]|0;
       $212 = (_d_base_from_value($211)|0);
       $213 = $212&255;
       $214 = (16 + ($213)|0);
       $215 = HEAP8[$214>>0]|0;
       $216 = $215&255;
       $217 = (80 + ($213<<2)|0);
       $218 = HEAP32[$217>>2]|0;
       $219 = (($211) - ($218))|0;
       $220 = $219 << $$sroa$26$0384;
       $221 = $220 | $$sroa$0281$0385;
       $222 = (($$sroa$26$0384) + ($216))|0;
       $223 = $$0356388 & 65535;
       $$sroa$0$0$$sroa_idx$i250 = (($7) + ($213<<3)|0);
       $$sroa$0$0$copyload$i251 = HEAP16[$$sroa$0$0$$sroa_idx$i250>>1]|0;
       $$sroa$4$0$$sroa_idx27$i252 = (((($7) + ($213<<3)|0)) + 2|0);
       $$sroa$4$0$copyload$i253 = HEAP16[$$sroa$4$0$$sroa_idx27$i252>>1]|0;
       $$sroa$5$0$$sroa_idx29$i254 = (((($7) + ($213<<3)|0)) + 4|0);
       $$sroa$5$0$copyload$i255 = HEAP16[$$sroa$5$0$$sroa_idx29$i254>>1]|0;
       $$sroa$6$0$$sroa_idx31$i256 = (((($7) + ($213<<3)|0)) + 6|0);
       $$sroa$6$0$copyload$i257 = HEAP16[$$sroa$6$0$$sroa_idx31$i256>>1]|0;
       $224 = $$sroa$0$0$copyload$i251 << 16 >> 16;
       $225 = $$sroa$4$0$copyload$i253 << 16 >> 16;
       $226 = ($223|0)>=($224|0);
       $not$$i258 = $226 ^ 1;
       $227 = $not$$i258 << 31 >> 31;
       $228 = (($227) + ($225))|0;
       $$v$i259 = $226 ? $$sroa$5$0$copyload$i255 : $$sroa$6$0$copyload$i257;
       $229 = (_fse_mask_lsb32($223,$228)|0);
       $230 = $229 << $222;
       $231 = $221 | $230;
       $232 = (($228) + ($222))|0;
       $233 = $$v$i259&65535;
       $234 = $223 >>> $228;
       $235 = (($234) + ($233))|0;
       $236 = $232 & -8;
       HEAP8[$$sroa$0$0$in389>>0]=$231&255;HEAP8[$$sroa$0$0$in389+1>>0]=($231>>8)&255;HEAP8[$$sroa$0$0$in389+2>>0]=($231>>16)&255;HEAP8[$$sroa$0$0$in389+3>>0]=$231>>24;
       $237 = $232 >> 3;
       $238 = (($$sroa$0$0$in389) + ($237)|0);
       $239 = $231 >>> $236;
       $240 = (($232) - ($236))|0;
       $241 = (((($0)) + 40052|0) + ($209<<2)|0);
       $242 = HEAP32[$241>>2]|0;
       $243 = (_m_base_from_value($242)|0);
       $244 = $243&255;
       $245 = (336 + ($244)|0);
       $246 = HEAP8[$245>>0]|0;
       $247 = $246&255;
       $248 = (368 + ($244<<2)|0);
       $249 = HEAP32[$248>>2]|0;
       $250 = (($242) - ($249))|0;
       $251 = $250 << $240;
       $252 = $251 | $239;
       $253 = (($240) + ($247))|0;
       $254 = $$0357387 & 65535;
       $$sroa$0$0$$sroa_idx$i240 = (($6) + ($244<<3)|0);
       $$sroa$0$0$copyload$i241 = HEAP16[$$sroa$0$0$$sroa_idx$i240>>1]|0;
       $$sroa$4$0$$sroa_idx27$i242 = (((($6) + ($244<<3)|0)) + 2|0);
       $$sroa$4$0$copyload$i243 = HEAP16[$$sroa$4$0$$sroa_idx27$i242>>1]|0;
       $$sroa$5$0$$sroa_idx29$i244 = (((($6) + ($244<<3)|0)) + 4|0);
       $$sroa$5$0$copyload$i245 = HEAP16[$$sroa$5$0$$sroa_idx29$i244>>1]|0;
       $$sroa$6$0$$sroa_idx31$i246 = (((($6) + ($244<<3)|0)) + 6|0);
       $$sroa$6$0$copyload$i247 = HEAP16[$$sroa$6$0$$sroa_idx31$i246>>1]|0;
       $255 = $$sroa$0$0$copyload$i241 << 16 >> 16;
       $256 = $$sroa$4$0$copyload$i243 << 16 >> 16;
       $257 = ($254|0)>=($255|0);
       $not$$i248 = $257 ^ 1;
       $258 = $not$$i248 << 31 >> 31;
       $259 = (($258) + ($256))|0;
       $$v$i249 = $257 ? $$sroa$5$0$copyload$i245 : $$sroa$6$0$copyload$i247;
       $260 = (_fse_mask_lsb32($254,$259)|0);
       $261 = $260 << $253;
       $262 = $252 | $261;
       $263 = (($259) + ($253))|0;
       $264 = $$v$i249&65535;
       $265 = $254 >>> $259;
       $266 = (($265) + ($264))|0;
       $267 = $263 & -8;
       HEAP8[$238>>0]=$262&255;HEAP8[$238+1>>0]=($262>>8)&255;HEAP8[$238+2>>0]=($262>>16)&255;HEAP8[$238+3>>0]=$262>>24;
       $268 = $263 >> 3;
       $269 = (($238) + ($268)|0);
       $270 = $262 >>> $267;
       $271 = (($263) - ($267))|0;
       $272 = (((($0)) + 52|0) + ($209<<2)|0);
       $273 = HEAP32[$272>>2]|0;
       $274 = (_l_base_from_value($273)|0);
       $275 = $274&255;
       $276 = (448 + ($275)|0);
       $277 = HEAP8[$276>>0]|0;
       $278 = $277&255;
       $279 = (480 + ($275<<2)|0);
       $280 = HEAP32[$279>>2]|0;
       $281 = (($273) - ($280))|0;
       $282 = $281 << $271;
       $283 = $282 | $270;
       $284 = (($271) + ($278))|0;
       $285 = $$0358386 & 65535;
       $$sroa$0$0$$sroa_idx$i210 = (($5) + ($275<<3)|0);
       $$sroa$0$0$copyload$i211 = HEAP16[$$sroa$0$0$$sroa_idx$i210>>1]|0;
       $$sroa$4$0$$sroa_idx27$i212 = (((($5) + ($275<<3)|0)) + 2|0);
       $$sroa$4$0$copyload$i213 = HEAP16[$$sroa$4$0$$sroa_idx27$i212>>1]|0;
       $$sroa$5$0$$sroa_idx29$i214 = (((($5) + ($275<<3)|0)) + 4|0);
       $$sroa$5$0$copyload$i215 = HEAP16[$$sroa$5$0$$sroa_idx29$i214>>1]|0;
       $$sroa$6$0$$sroa_idx31$i216 = (((($5) + ($275<<3)|0)) + 6|0);
       $$sroa$6$0$copyload$i217 = HEAP16[$$sroa$6$0$$sroa_idx31$i216>>1]|0;
       $286 = $$sroa$0$0$copyload$i211 << 16 >> 16;
       $287 = $$sroa$4$0$copyload$i213 << 16 >> 16;
       $288 = ($285|0)>=($286|0);
       $not$$i218 = $288 ^ 1;
       $289 = $not$$i218 << 31 >> 31;
       $290 = (($289) + ($287))|0;
       $$v$i219 = $288 ? $$sroa$5$0$copyload$i215 : $$sroa$6$0$copyload$i217;
       $291 = (_fse_mask_lsb32($285,$290)|0);
       $292 = $291 << $284;
       $293 = $283 | $292;
       $294 = (($290) + ($284))|0;
       $295 = $$v$i219&65535;
       $296 = $285 >>> $290;
       $297 = (($296) + ($295))|0;
       $298 = $294 & -8;
       HEAP8[$269>>0]=$293&255;HEAP8[$269+1>>0]=($293>>8)&255;HEAP8[$269+2>>0]=($293>>16)&255;HEAP8[$269+3>>0]=$293>>24;
       $299 = $294 >> 3;
       $300 = (($269) + ($299)|0);
       $301 = $293 >>> $298;
       $302 = (($294) - ($298))|0;
       $303 = ($209|0)==(0);
       if ($303) {
        break;
       } else {
        $$0199390 = $209;$$0356388 = $235;$$0357387 = $266;$$0358386 = $297;$$sroa$0$0$in389 = $300;$$sroa$0281$0385 = $301;$$sroa$26$0384 = $302;
       }
      }
      $304 = $297&65535;
      $305 = $266&65535;
      $306 = $235&65535;
      $$0356$lcssa = $306;$$0357$lcssa = $305;$$0358$lcssa = $304;$$sroa$0$0$in$lcssa = $300;$$sroa$0281$0$lcssa = $301;$$sroa$26$0$lcssa = $302;
     }
     $307 = (($$sroa$26$0$lcssa) + 7)|0;
     $308 = $307 & -8;
     HEAP8[$$sroa$0$0$in$lcssa>>0]=$$sroa$0281$0$lcssa&255;HEAP8[$$sroa$0$0$in$lcssa+1>>0]=($$sroa$0281$0$lcssa>>8)&255;HEAP8[$$sroa$0$0$in$lcssa+2>>0]=($$sroa$0281$0$lcssa>>16)&255;HEAP8[$$sroa$0$0$in$lcssa+3>>0]=$$sroa$0281$0$lcssa>>24;
     $309 = $307 >> 3;
     $310 = (($$sroa$0$0$in$lcssa) + ($309)|0);
     $311 = $310;
     $312 = (($$sroa$26$0$lcssa) - ($308))|0;
     $313 = HEAP32[$16>>2]|0;
     $314 = (($311) - ($313))|0;
     $315 = ((($9)) + 24|0);
     HEAP32[$315>>2] = $314;
     $316 = ((($9)) + 40|0);
     HEAP32[$316>>2] = $312;
     $317 = ((($9)) + 44|0);
     HEAP16[$317>>1] = $$0358$lcssa;
     $318 = ((($9)) + 46|0);
     HEAP16[$318>>1] = $$0357$lcssa;
     $319 = ((($9)) + 48|0);
     HEAP16[$319>>1] = $$0356$lcssa;
     HEAP32[$16>>2] = $311;
     HEAP32[$10>>2] = 0;
     HEAP32[$26>>2] = 0;
     $320 = HEAP32[$192>>2]|0;
     $321 = (($314) + ($320))|0;
     $322 = ((($9)) + 8|0);
     HEAP32[$322>>2] = $321;
     _lzfse_encode_v1_state($64,$9);
     $$0 = 0;
    }
   }
  } while(0);
  if ((label|0) == 36) {
   $323 = HEAP32[$26>>2]|0;
   $324 = ($323|0)==(0);
   if (!($324)) {
    $$0182383 = 0;$$0183382 = 0;$332 = $323;
    while(1) {
     $325 = (((($0)) + 80052|0) + ($$0182383<<2)|0);
     $326 = HEAP32[$325>>2]|0;
     $327 = ($326|0)==(0);
     if ($327) {
      HEAP32[$325>>2] = $$0183382;
      $$pre468 = HEAP32[$26>>2]|0;
      $$1184 = $$0183382;$330 = $$pre468;
     } else {
      $$1184 = $326;$330 = $332;
     }
     $328 = (($$0182383) + 1)|0;
     $329 = ($328>>>0)<($330>>>0);
     if ($329) {
      $$0182383 = $328;$$0183382 = $$1184;$332 = $330;
     } else {
      break;
     }
    }
   }
   HEAP32[$10>>2] = $11;
   HEAP32[$16>>2] = $17;
   $$0 = -2;
  }
  $$1 = $$0;
 }
 STACKTOP = sp;return ($$1|0);
}
function _l_base_from_value($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = (3184 + ($0)|0);
 $2 = HEAP8[$1>>0]|0;
 return ($2|0);
}
function _m_base_from_value($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = (816 + ($0)|0);
 $2 = HEAP8[$1>>0]|0;
 return ($2|0);
}
function _d_base_from_value($0) {
 $0 = $0|0;
 var $$off = 0, $$off24 = 0, $$off25 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $3 = 0, $4 = 0, $5 = 0;
 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ($0>>>0)<(60);
 $2 = $1 ? $0 : 0;
 $$off = (($0) + -60)|0;
 $3 = ($$off>>>0)<(960);
 $4 = $$off >> 4;
 $5 = (($4) + 64)|0;
 $6 = $3 ? $5 : 0;
 $7 = $6 | $2;
 $$off24 = (($0) + -1020)|0;
 $8 = ($$off24>>>0)<(15360);
 $9 = $$off24 >>> 8;
 $10 = (($9) + 128)|0;
 $11 = $8 ? $10 : 0;
 $12 = $7 | $11;
 $$off25 = (($0) + -16380)|0;
 $13 = ($$off25>>>0)<(245760);
 $14 = (($0) + 1032196)|0;
 $15 = $14 >>> 12;
 $16 = (($15) + 192)|0;
 $17 = $13 ? $16 : 0;
 $18 = $12 | $17;
 $19 = $18 & 255;
 $20 = (560 + ($19)|0);
 $21 = HEAP8[$20>>0]|0;
 return ($21|0);
}
function _fse_normalize_freq($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$0 = 0, $$05365 = 0, $$05469 = 0, $$055 = 0, $$05668 = 0, $$057$lcssa = 0, $$05764 = 0, $$058$lcssa = 0, $$05863 = 0, $$060$lcssa = 0, $$06062 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0;
 var $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
 var $9 = 0, $exitcond = 0, $exitcond75 = 0, $or$cond = 0, $spec$select = 0, $spec$select61 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = (Math_clz32(($0|0))|0);
 $5 = (($4) + -1)|0;
 $6 = ($1|0)>(0);
 if ($6) {
  $$05469 = 0;$$05668 = 0;
  while(1) {
   $9 = (($2) + ($$05469<<2)|0);
   $10 = HEAP32[$9>>2]|0;
   $8 = (($10) + ($$05668))|0;
   $11 = (($$05469) + 1)|0;
   $exitcond75 = ($11|0)==($1|0);
   if ($exitcond75) {
    break;
   } else {
    $$05469 = $11;$$05668 = $8;
   }
  }
  $7 = ($8|0)==(0);
  if ($7) {
   $$055 = 0;
  } else {
   $12 = (2147483648 / ($8>>>0))&-1;
   $$055 = $12;
  }
  if ($6) {
   $$05365 = 0;$$05764 = 0;$$05863 = 0;$$06062 = $0;
   while(1) {
    $16 = (($2) + ($$05365<<2)|0);
    $17 = HEAP32[$16>>2]|0;
    $18 = Math_imul($17, $$055)|0;
    $19 = $18 >>> $5;
    $20 = (($19) + 1)|0;
    $21 = $20 >>> 1;
    $22 = ($21|0)!=(0);
    $23 = ($17|0)==(0);
    $or$cond = $23 | $22;
    $$0 = $or$cond ? $21 : 1;
    $24 = $$0&65535;
    $25 = (($3) + ($$05365<<1)|0);
    HEAP16[$25>>1] = $24;
    $26 = (($$06062) - ($$0))|0;
    $27 = ($$0|0)>($$05863|0);
    $spec$select = $27 ? $$0 : $$05863;
    $spec$select61 = $27 ? $$05365 : $$05764;
    $28 = (($$05365) + 1)|0;
    $exitcond = ($28|0)==($1|0);
    if ($exitcond) {
     break;
    } else {
     $$05365 = $28;$$05764 = $spec$select61;$$05863 = $spec$select;$$06062 = $26;
    }
   }
   $13 = $spec$select >>> 2;
   $$057$lcssa = $spec$select61;$$058$lcssa = $13;$$060$lcssa = $26;
  } else {
   $$057$lcssa = 0;$$058$lcssa = 0;$$060$lcssa = $0;
  }
 } else {
  $$057$lcssa = 0;$$058$lcssa = 0;$$060$lcssa = $0;
 }
 $14 = (0 - ($$060$lcssa))|0;
 $15 = ($$058$lcssa|0)>($14|0);
 if ($15) {
  $29 = (($3) + ($$057$lcssa<<1)|0);
  $30 = HEAP16[$29>>1]|0;
  $31 = $30&65535;
  $32 = (($$060$lcssa) + ($31))|0;
  $33 = $32&65535;
  HEAP16[$29>>1] = $33;
 } else {
  _fse_adjust_freqs($3,$14,$1);
 }
 return;
}
function _lzfse_encode_v1_freq_table($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$03951 = 0, $$04150 = 0, $$04249 = 0, $$052 = 0, $$1$lcssa = 0, $$140$lcssa = 0, $$14045 = 0, $$143$lcssa = 0, $$14344 = 0, $$146 = 0, $$2 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0;
 var $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0;
 var $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $exitcond = 0, $scevgep = 0, $scevgep55 = 0, $smax = 0, dest = 0, label = 0, sp = 0, stop = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $2 = sp;
 $3 = ((($0)) + 32|0);
 $$03951 = 0;$$04150 = 0;$$04249 = $3;$$052 = 0;
 while(1) {
  HEAP32[$2>>2] = 0;
  $5 = (((($1)) + 50|0) + ($$04150<<1)|0);
  $6 = HEAP16[$5>>1]|0;
  $7 = $6&65535;
  $8 = (_lzfse_encode_v1_freq_value($7,$2)|0);
  $9 = $8 << $$03951;
  $10 = $9 | $$052;
  $11 = HEAP32[$2>>2]|0;
  $12 = (($11) + ($$03951))|0;
  $13 = ($12|0)>(7);
  if ($13) {
   $14 = (($$03951) + -8)|0;
   $15 = (($$03951) + 8)|0;
   $16 = (($15) + ($11))|0;
   $17 = $12 ^ -1;
   $18 = ($17|0)>(-16);
   $smax = $18 ? $17 : -16;
   $19 = (($16) + ($smax))|0;
   $20 = $19 >>> 3;
   $21 = $19 & -8;
   $scevgep = ((($$04249)) + 1|0);
   $$14045 = $12;$$14344 = $$04249;$$146 = $10;
   while(1) {
    $22 = $$146&255;
    HEAP8[$$14344>>0] = $22;
    $23 = $$146 >>> 8;
    $24 = (($$14045) + -8)|0;
    $25 = ((($$14344)) + 1|0);
    $26 = ($$14045|0)>(15);
    if ($26) {
     $$14045 = $24;$$14344 = $25;$$146 = $23;
    } else {
     break;
    }
   }
   $27 = (($14) + ($11))|0;
   $28 = (($27) - ($21))|0;
   $scevgep55 = (($scevgep) + ($20)|0);
   $$1$lcssa = $23;$$140$lcssa = $28;$$143$lcssa = $scevgep55;
  } else {
   $$1$lcssa = $10;$$140$lcssa = $12;$$143$lcssa = $$04249;
  }
  $29 = (($$04150) + 1)|0;
  $exitcond = ($29|0)==(360);
  if ($exitcond) {
   break;
  } else {
   $$03951 = $$140$lcssa;$$04150 = $29;$$04249 = $$143$lcssa;$$052 = $$1$lcssa;
  }
 }
 $4 = ($$140$lcssa|0)>(0);
 if ($4) {
  $30 = $$1$lcssa&255;
  HEAP8[$$143$lcssa>>0] = $30;
  $31 = ((($$143$lcssa)) + 1|0);
  $$2 = $31;
 } else {
  $$2 = $$143$lcssa;
 }
 $32 = $$2;
 $33 = $0;
 $34 = (($32) - ($33))|0;
 $35 = ((($0)) + 8|0);
 $36 = (_setField($34,0)|0);
 $37 = (getTempRet0() | 0);
 $38 = ((($0)) + 24|0);
 dest=$35; stop=dest+16|0; do { HEAP8[dest>>0]=0|0; dest=dest+1|0; } while ((dest|0) < (stop|0));
 $39 = $38;
 $40 = $39;
 HEAP8[$40>>0]=$36&255;HEAP8[$40+1>>0]=($36>>8)&255;HEAP8[$40+2>>0]=($36>>16)&255;HEAP8[$40+3>>0]=$36>>24;
 $41 = (($39) + 4)|0;
 $42 = $41;
 HEAP8[$42>>0]=$37&255;HEAP8[$42+1>>0]=($37>>8)&255;HEAP8[$42+2>>0]=($37>>16)&255;HEAP8[$42+3>>0]=$37>>24;
 STACKTOP = sp;return ($34|0);
}
function _fse_init_encoder_table($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$04042 = 0, $$043 = 0, $$1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0;
 var $27 = 0, $28 = 0, $29 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $exitcond = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = (Math_clz32(($0|0))|0);
 $5 = ($1|0)>(0);
 if ($5) {
  $$04042 = 0;$$043 = 0;
  while(1) {
   $6 = (($2) + ($$04042<<1)|0);
   $7 = HEAP16[$6>>1]|0;
   $8 = $7&65535;
   $9 = ($7<<16>>16)==(0);
   if ($9) {
    $$1 = $$043;
   } else {
    $10 = (Math_clz32(($8|0))|0);
    $11 = (($10) - ($4))|0;
    $12 = $8 << $11;
    $13 = (($12) - ($0))|0;
    $14 = $13&65535;
    $15 = (($3) + ($$04042<<3)|0);
    HEAP16[$15>>1] = $14;
    $16 = $11&65535;
    $17 = (((($3) + ($$04042<<3)|0)) + 2|0);
    HEAP16[$17>>1] = $16;
    $18 = (($$043) - ($8))|0;
    $19 = $0 >> $11;
    $20 = (($19) + ($18))|0;
    $21 = $20&65535;
    $22 = (((($3) + ($$04042<<3)|0)) + 4|0);
    HEAP16[$22>>1] = $21;
    $23 = (($11) + -1)|0;
    $24 = $0 >> $23;
    $25 = (($24) + ($18))|0;
    $26 = $25&65535;
    $27 = (((($3) + ($$04042<<3)|0)) + 6|0);
    HEAP16[$27>>1] = $26;
    $28 = (($$043) + ($8))|0;
    $$1 = $28;
   }
   $29 = (($$04042) + 1)|0;
   $exitcond = ($29|0)==($1|0);
   if ($exitcond) {
    break;
   } else {
    $$04042 = $29;$$043 = $$1;
   }
  }
 }
 return;
}
function _fse_mask_lsb32($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = (4528 + ($1<<2)|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = $3 & $0;
 return ($4|0);
}
function _lzfse_encode_v1_state($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0;
 var $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0;
 var $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0;
 var $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0;
 var $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0;
 var $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 HEAP8[$0>>0]=846755426&255;HEAP8[$0+1>>0]=(846755426>>8)&255;HEAP8[$0+2>>0]=(846755426>>16)&255;HEAP8[$0+3>>0]=846755426>>24;
 $2 = ((($1)) + 4|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = ((($0)) + 4|0);
 HEAP8[$4>>0]=$3&255;HEAP8[$4+1>>0]=($3>>8)&255;HEAP8[$4+2>>0]=($3>>16)&255;HEAP8[$4+3>>0]=$3>>24;
 $5 = ((($1)) + 12|0);
 $6 = HEAP32[$5>>2]|0;
 $7 = (_setField($6,0)|0);
 $8 = (getTempRet0() | 0);
 $9 = ((($1)) + 20|0);
 $10 = HEAP32[$9>>2]|0;
 $11 = (_setField($10,20)|0);
 $12 = (getTempRet0() | 0);
 $13 = $11 | $7;
 $14 = $12 | $8;
 $15 = ((($1)) + 16|0);
 $16 = HEAP32[$15>>2]|0;
 $17 = (_setField($16,40)|0);
 $18 = (getTempRet0() | 0);
 $19 = $13 | $17;
 $20 = $14 | $18;
 $21 = ((($1)) + 28|0);
 $22 = HEAP32[$21>>2]|0;
 $23 = (($22) + 7)|0;
 $24 = (_setField($23,60)|0);
 $25 = (getTempRet0() | 0);
 $26 = $19 | $24;
 $27 = $20 | $25;
 $28 = ((($0)) + 8|0);
 $29 = $28;
 $30 = $29;
 HEAP8[$30>>0]=$26&255;HEAP8[$30+1>>0]=($26>>8)&255;HEAP8[$30+2>>0]=($26>>16)&255;HEAP8[$30+3>>0]=$26>>24;
 $31 = (($29) + 4)|0;
 $32 = $31;
 HEAP8[$32>>0]=$27&255;HEAP8[$32+1>>0]=($27>>8)&255;HEAP8[$32+2>>0]=($27>>16)&255;HEAP8[$32+3>>0]=$27>>24;
 $33 = ((($1)) + 32|0);
 $34 = HEAP16[$33>>1]|0;
 $35 = $34&65535;
 $36 = (_setField($35,0)|0);
 $37 = (getTempRet0() | 0);
 $38 = ((($1)) + 34|0);
 $39 = HEAP16[$38>>1]|0;
 $40 = $39&65535;
 $41 = (_setField($40,10)|0);
 $42 = (getTempRet0() | 0);
 $43 = $41 | $36;
 $44 = $42 | $37;
 $45 = ((($1)) + 36|0);
 $46 = HEAP16[$45>>1]|0;
 $47 = $46&65535;
 $48 = (_setField($47,20)|0);
 $49 = (getTempRet0() | 0);
 $50 = $43 | $48;
 $51 = $44 | $49;
 $52 = ((($1)) + 38|0);
 $53 = HEAP16[$52>>1]|0;
 $54 = $53&65535;
 $55 = (_setField($54,30)|0);
 $56 = (getTempRet0() | 0);
 $57 = $50 | $55;
 $58 = $51 | $56;
 $59 = ((($1)) + 24|0);
 $60 = HEAP32[$59>>2]|0;
 $61 = (_setField($60,40)|0);
 $62 = (getTempRet0() | 0);
 $63 = $57 | $61;
 $64 = $58 | $62;
 $65 = ((($1)) + 40|0);
 $66 = HEAP32[$65>>2]|0;
 $67 = (($66) + 7)|0;
 $68 = (_setField($67,60)|0);
 $69 = (getTempRet0() | 0);
 $70 = $63 | $68;
 $71 = $64 | $69;
 $72 = ((($0)) + 16|0);
 $73 = $72;
 $74 = $73;
 HEAP8[$74>>0]=$70&255;HEAP8[$74+1>>0]=($70>>8)&255;HEAP8[$74+2>>0]=($70>>16)&255;HEAP8[$74+3>>0]=$70>>24;
 $75 = (($73) + 4)|0;
 $76 = $75;
 HEAP8[$76>>0]=$71&255;HEAP8[$76+1>>0]=($71>>8)&255;HEAP8[$76+2>>0]=($71>>16)&255;HEAP8[$76+3>>0]=$71>>24;
 $77 = ((($0)) + 24|0);
 $78 = $77;
 $79 = $78;
 $80 = HEAPU8[$79>>0]|(HEAPU8[$79+1>>0]<<8)|(HEAPU8[$79+2>>0]<<16)|(HEAPU8[$79+3>>0]<<24);
 $81 = (($78) + 4)|0;
 $82 = $81;
 $83 = HEAPU8[$82>>0]|(HEAPU8[$82+1>>0]<<8)|(HEAPU8[$82+2>>0]<<16)|(HEAPU8[$82+3>>0]<<24);
 $84 = ((($1)) + 44|0);
 $85 = HEAP16[$84>>1]|0;
 $86 = $85&65535;
 $87 = (_setField($86,32)|0);
 $88 = (getTempRet0() | 0);
 $89 = $87 | $80;
 $90 = $88 | $83;
 $91 = ((($1)) + 46|0);
 $92 = HEAP16[$91>>1]|0;
 $93 = $92&65535;
 $94 = (_setField($93,42)|0);
 $95 = (getTempRet0() | 0);
 $96 = $89 | $94;
 $97 = $90 | $95;
 $98 = ((($1)) + 48|0);
 $99 = HEAP16[$98>>1]|0;
 $100 = $99&65535;
 $101 = (_setField($100,52)|0);
 $102 = (getTempRet0() | 0);
 $103 = $96 | $101;
 $104 = $97 | $102;
 $105 = $77;
 $106 = $105;
 HEAP8[$106>>0]=$103&255;HEAP8[$106+1>>0]=($103>>8)&255;HEAP8[$106+2>>0]=($103>>16)&255;HEAP8[$106+3>>0]=$103>>24;
 $107 = (($105) + 4)|0;
 $108 = $107;
 HEAP8[$108>>0]=$104&255;HEAP8[$108+1>>0]=($104>>8)&255;HEAP8[$108+2>>0]=($104>>16)&255;HEAP8[$108+3>>0]=$104>>24;
 return;
}
function _setField($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($1|0)<(0);
 $3 = $2 << 31 >> 31;
 $4 = (_bitshift64Shl(($0|0),0,($1|0))|0);
 $5 = (getTempRet0() | 0);
 setTempRet0(($5) | 0);
 return ($4|0);
}
function _lzfse_encode_v1_freq_value($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 L1: do {
  switch ($0|0) {
  case 0:  {
   HEAP32[$1>>2] = 2;
   $$0 = 0;
   break;
  }
  case 1:  {
   HEAP32[$1>>2] = 2;
   $$0 = 2;
   break;
  }
  case 2:  {
   HEAP32[$1>>2] = 3;
   $$0 = 1;
   break;
  }
  case 3:  {
   HEAP32[$1>>2] = 3;
   $$0 = 5;
   break;
  }
  case 4:  {
   HEAP32[$1>>2] = 5;
   $$0 = 3;
   break;
  }
  case 5:  {
   HEAP32[$1>>2] = 5;
   $$0 = 11;
   break;
  }
  case 6:  {
   HEAP32[$1>>2] = 5;
   $$0 = 19;
   break;
  }
  case 7:  {
   HEAP32[$1>>2] = 5;
   $$0 = 27;
   break;
  }
  default: {
   $2 = ($0|0)<(24);
   if ($2) {
    HEAP32[$1>>2] = 8;
    $3 = $0 << 4;
    $4 = (($3) + -121)|0;
    $$0 = $4;
    break L1;
   } else {
    HEAP32[$1>>2] = 14;
    $5 = $0 << 4;
    $6 = (($5) + -369)|0;
    $$0 = $6;
    break L1;
   }
  }
  }
 } while(0);
 return ($$0|0);
}
function _fse_adjust_freqs($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$02429 = 0, $$02633 = 0, $$02732 = 0, $$128 = 0, $$2 = 0, $$3 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0;
 var $7 = 0, $8 = 0, $9 = 0, $spec$select = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ($1|0)==(0);
 L1: do {
  if (!($3)) {
   $4 = ($2|0)>(0);
   $$02633 = 3;$$02732 = $1;
   while(1) {
    if ($4) {
     $$02429 = 0;$$128 = $$02732;
     while(1) {
      $5 = (($0) + ($$02429<<1)|0);
      $6 = HEAP16[$5>>1]|0;
      $7 = ($6&65535)>(1);
      if ($7) {
       $8 = $6&65535;
       $9 = (($8) + -1)|0;
       $10 = $9 >> $$02633;
       $11 = ($10|0)>($$128|0);
       $spec$select = $11 ? $$128 : $10;
       $12 = (($8) - ($spec$select))|0;
       $13 = $12&65535;
       HEAP16[$5>>1] = $13;
       $14 = (($$128) - ($spec$select))|0;
       $15 = ($14|0)==(0);
       if ($15) {
        break L1;
       } else {
        $$2 = $14;
       }
      } else {
       $$2 = $$128;
      }
      $16 = (($$02429) + 1)|0;
      $17 = ($16|0)<($2|0);
      if ($17) {
       $$02429 = $16;$$128 = $$2;
      } else {
       $$3 = $$2;
       break;
      }
     }
    } else {
     $$3 = $$02732;
    }
    $18 = (($$02633) + -1)|0;
    $19 = ($$3|0)==(0);
    if ($19) {
     break;
    } else {
     $$02633 = $18;$$02732 = $$3;
    }
   }
  }
 } while(0);
 return;
}
function _lzfse_push_match($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$045 = 0, $$046$lcssa = 0, $$04655 = 0, $$047$lcssa = 0, $$04757 = 0, $$1$lcssa = 0, $$154 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0;
 var $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ((($0)) + 44|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = ((($0)) + 48|0);
 $5 = HEAP32[$4>>2]|0;
 $6 = ((($0)) + 8|0);
 $7 = HEAP32[$6>>2]|0;
 $8 = HEAP32[$1>>2]|0;
 $9 = (($8) - ($7))|0;
 $10 = ((($1)) + 8|0);
 $11 = HEAP32[$10>>2]|0;
 $12 = ((($1)) + 4|0);
 $13 = HEAP32[$12>>2]|0;
 $14 = (($8) - ($13))|0;
 $15 = ($9>>>0)>(315);
 L1: do {
  if ($15) {
   $$04757 = $9;
   while(1) {
    $16 = (_lzfse_push_lmd($0,315,0,1)|0);
    $17 = ($16|0)==(0);
    if (!($17)) {
     label = 11;
     break L1;
    }
    $18 = (($$04757) + -315)|0;
    $19 = ($18>>>0)>(315);
    if ($19) {
     $$04757 = $18;
    } else {
     $$047$lcssa = $18;
     label = 5;
     break;
    }
   }
  } else {
   $$047$lcssa = $9;
   label = 5;
  }
 } while(0);
 L6: do {
  if ((label|0) == 5) {
   $20 = ($11>>>0)>(2359);
   if ($20) {
    $$04655 = $11;$$154 = $$047$lcssa;
    while(1) {
     $21 = (_lzfse_push_lmd($0,$$154,2359,$14)|0);
     $22 = ($21|0)==(0);
     if (!($22)) {
      label = 11;
      break L6;
     }
     $23 = (($$04655) + -2359)|0;
     $24 = ($23>>>0)>(2359);
     if ($24) {
      $$04655 = $23;$$154 = 0;
     } else {
      $$046$lcssa = $23;$$1$lcssa = 0;
      break;
     }
    }
   } else {
    $$046$lcssa = $11;$$1$lcssa = $$047$lcssa;
   }
   $25 = $$046$lcssa | $$1$lcssa;
   $26 = ($25|0)==(0);
   if ($26) {
    $$045 = 0;
   } else {
    $27 = (_lzfse_push_lmd($0,$$1$lcssa,$$046$lcssa,$14)|0);
    $28 = ($27|0)==(0);
    if ($28) {
     $$045 = 0;
    } else {
     label = 11;
    }
   }
  }
 } while(0);
 if ((label|0) == 11) {
  HEAP32[$2>>2] = $3;
  HEAP32[$4>>2] = $5;
  HEAP32[$6>>2] = $7;
  $$045 = -2;
 }
 return ($$045|0);
}
function _lzfse_push_lmd($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$0 = 0, $$04861 = 0, $$049 = 0, $$04958 = 0, $$04962 = 0, $$pn = 0, $$pn59 = 0, $$pn59$phi = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0;
 var $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0;
 var $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0;
 var $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0;
 var $78 = 0, $79 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = ((($0)) + 44|0);
 $5 = HEAP32[$4>>2]|0;
 $6 = (($5) + 1)|0;
 $7 = (($5) + 9)|0;
 $8 = ($7>>>0)>(10000);
 if ($8) {
  $$0 = -2;
 } else {
  $9 = ((($0)) + 48|0);
  $10 = HEAP32[$9>>2]|0;
  $11 = (($1) + 16)|0;
  $12 = (($11) + ($10))|0;
  $13 = ($12>>>0)>(40000);
  if ($13) {
   $$0 = -2;
  } else {
   HEAP32[$4>>2] = $6;
   $14 = (((($0)) + 52|0) + ($5<<2)|0);
   HEAP32[$14>>2] = $1;
   $15 = (((($0)) + 40052|0) + ($5<<2)|0);
   HEAP32[$15>>2] = $2;
   $16 = (((($0)) + 80052|0) + ($5<<2)|0);
   HEAP32[$16>>2] = $3;
   $17 = HEAP32[$9>>2]|0;
   $18 = (((($0)) + 120052|0) + ($17)|0);
   $19 = HEAP32[$0>>2]|0;
   $20 = ((($0)) + 8|0);
   $21 = HEAP32[$20>>2]|0;
   $22 = (($19) + ($21)|0);
   $23 = (($18) + ($1)|0);
   $24 = (($11) + ($21))|0;
   $25 = ((($0)) + 4|0);
   $26 = HEAP32[$25>>2]|0;
   $27 = ($24>>>0)>($26>>>0);
   if ($27) {
    $28 = ($1|0)==(0);
    if (!($28)) {
     _memcpy(($18|0),($22|0),($1|0))|0;
    }
   } else {
    $29 = $22;
    $30 = $29;
    $31 = HEAPU8[$30>>0]|(HEAPU8[$30+1>>0]<<8)|(HEAPU8[$30+2>>0]<<16)|(HEAPU8[$30+3>>0]<<24);
    $32 = (($29) + 4)|0;
    $33 = $32;
    $34 = HEAPU8[$33>>0]|(HEAPU8[$33+1>>0]<<8)|(HEAPU8[$33+2>>0]<<16)|(HEAPU8[$33+3>>0]<<24);
    $35 = ((($22)) + 8|0);
    $36 = $35;
    $37 = $36;
    $38 = HEAPU8[$37>>0]|(HEAPU8[$37+1>>0]<<8)|(HEAPU8[$37+2>>0]<<16)|(HEAPU8[$37+3>>0]<<24);
    $39 = (($36) + 4)|0;
    $40 = $39;
    $41 = HEAPU8[$40>>0]|(HEAPU8[$40+1>>0]<<8)|(HEAPU8[$40+2>>0]<<16)|(HEAPU8[$40+3>>0]<<24);
    $42 = $18;
    $43 = $42;
    HEAP8[$43>>0]=$31&255;HEAP8[$43+1>>0]=($31>>8)&255;HEAP8[$43+2>>0]=($31>>16)&255;HEAP8[$43+3>>0]=$31>>24;
    $44 = (($42) + 4)|0;
    $45 = $44;
    HEAP8[$45>>0]=$34&255;HEAP8[$45+1>>0]=($34>>8)&255;HEAP8[$45+2>>0]=($34>>16)&255;HEAP8[$45+3>>0]=$34>>24;
    $46 = ((($18)) + 8|0);
    $47 = $46;
    $48 = $47;
    HEAP8[$48>>0]=$38&255;HEAP8[$48+1>>0]=($38>>8)&255;HEAP8[$48+2>>0]=($38>>16)&255;HEAP8[$48+3>>0]=$38>>24;
    $49 = (($47) + 4)|0;
    $50 = $49;
    HEAP8[$50>>0]=$41&255;HEAP8[$50+1>>0]=($41>>8)&255;HEAP8[$50+2>>0]=($41>>16)&255;HEAP8[$50+3>>0]=$41>>24;
    $51 = ($1|0)>(16);
    if ($51) {
     $$04958 = ((($18)) + 16|0);
     $$04962 = $$04958;$$pn = $22;$$pn59 = $18;
     while(1) {
      $$04861 = ((($$pn)) + 16|0);
      $52 = $$04861;
      $53 = $52;
      $54 = HEAPU8[$53>>0]|(HEAPU8[$53+1>>0]<<8)|(HEAPU8[$53+2>>0]<<16)|(HEAPU8[$53+3>>0]<<24);
      $55 = (($52) + 4)|0;
      $56 = $55;
      $57 = HEAPU8[$56>>0]|(HEAPU8[$56+1>>0]<<8)|(HEAPU8[$56+2>>0]<<16)|(HEAPU8[$56+3>>0]<<24);
      $58 = ((($$pn)) + 24|0);
      $59 = $58;
      $60 = $59;
      $61 = HEAPU8[$60>>0]|(HEAPU8[$60+1>>0]<<8)|(HEAPU8[$60+2>>0]<<16)|(HEAPU8[$60+3>>0]<<24);
      $62 = (($59) + 4)|0;
      $63 = $62;
      $64 = HEAPU8[$63>>0]|(HEAPU8[$63+1>>0]<<8)|(HEAPU8[$63+2>>0]<<16)|(HEAPU8[$63+3>>0]<<24);
      $65 = $$04962;
      $66 = $65;
      HEAP8[$66>>0]=$54&255;HEAP8[$66+1>>0]=($54>>8)&255;HEAP8[$66+2>>0]=($54>>16)&255;HEAP8[$66+3>>0]=$54>>24;
      $67 = (($65) + 4)|0;
      $68 = $67;
      HEAP8[$68>>0]=$57&255;HEAP8[$68+1>>0]=($57>>8)&255;HEAP8[$68+2>>0]=($57>>16)&255;HEAP8[$68+3>>0]=$57>>24;
      $69 = ((($$pn59)) + 24|0);
      $70 = $69;
      $71 = $70;
      HEAP8[$71>>0]=$61&255;HEAP8[$71+1>>0]=($61>>8)&255;HEAP8[$71+2>>0]=($61>>16)&255;HEAP8[$71+3>>0]=$61>>24;
      $72 = (($70) + 4)|0;
      $73 = $72;
      HEAP8[$73>>0]=$64&255;HEAP8[$73+1>>0]=($64>>8)&255;HEAP8[$73+2>>0]=($64>>16)&255;HEAP8[$73+3>>0]=$64>>24;
      $$049 = ((($$04962)) + 16|0);
      $74 = ($$049>>>0)<($23>>>0);
      if ($74) {
       $$pn59$phi = $$04962;$$04962 = $$049;$$pn = $$04861;$$pn59 = $$pn59$phi;
      } else {
       break;
      }
     }
    }
   }
   $75 = HEAP32[$9>>2]|0;
   $76 = (($75) + ($1))|0;
   HEAP32[$9>>2] = $76;
   $77 = (($2) + ($1))|0;
   $78 = HEAP32[$20>>2]|0;
   $79 = (($77) + ($78))|0;
   HEAP32[$20>>2] = $79;
   $$0 = 0;
  }
 }
 return ($$0|0);
}
function _hashX($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = Math_imul($0, -1640531535)|0;
 $2 = $1 >>> 18;
 return ($2|0);
}
function _lzvn_encode_partial($0,$1,$2,$3,$4,$5) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 var $$0 = 0, $$pre = 0, $$pre16 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0;
 var $27 = 0, $28 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, dest = 0, label = 0, sp = 0, stop = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 64|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(64|0);
 $6 = sp;
 $7 = ($1>>>0)<(8);
 if ($7) {
  HEAP32[$4>>2] = 0;
  $$0 = 0;
 } else {
  $8 = ((($6)) + 16|0);
  dest=$8; stop=dest+44|0; do { HEAP32[dest>>2]=0|0; dest=dest+4|0; } while ((dest|0) < (stop|0));
  HEAP32[$6>>2] = $2;
  $9 = ((($6)) + 4|0);
  HEAP32[$9>>2] = 0;
  $10 = ((($6)) + 8|0);
  HEAP32[$10>>2] = $3;
  $11 = ((($6)) + 20|0);
  HEAP32[$11>>2] = 0;
  $12 = ((($6)) + 12|0);
  HEAP32[$12>>2] = 0;
  $13 = ((($6)) + 24|0);
  HEAP32[$13>>2] = $0;
  $14 = ((($6)) + 28|0);
  HEAP32[$14>>2] = $0;
  $15 = (($0) + ($1)|0);
  $16 = ((($15)) + -8|0);
  $17 = ((($6)) + 32|0);
  HEAP32[$17>>2] = $16;
  $18 = ((($6)) + 60|0);
  HEAP32[$18>>2] = $5;
  $19 = ($3>>>0)>(7);
  if ($19) {
   $20 = ((($6)) + 16|0);
   $21 = (($3) + -8)|0;
   HEAP32[$20>>2] = $21;
   _lzvn_init_table($6);
   _lzvn_encode($6);
   $$pre = HEAP32[$10>>2]|0;
   $$pre16 = HEAP32[$11>>2]|0;
   $23 = $$pre;$24 = $$pre16;
  } else {
   $23 = $3;$24 = 0;
  }
  $22 = (($23) - ($24))|0;
  (_lzvn_emit_literal($6,$22)|0);
  HEAP32[$17>>2] = $15;
  _lzvn_emit_end_of_stream($6);
  $25 = HEAP32[$11>>2]|0;
  HEAP32[$4>>2] = $25;
  $26 = HEAP32[$13>>2]|0;
  $27 = HEAP32[$14>>2]|0;
  $28 = (($26) - ($27))|0;
  $$0 = $28;
 }
 STACKTOP = sp;return ($$0|0);
}
function _lzvn_init_table($0) {
 $0 = $0|0;
 var $$0$copyload$i = 0, $$02124 = 0, $$023 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $exitcond = 0, $exitcond25 = 0, $spec$select = 0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 32|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(32|0);
 $1 = sp;
 $2 = ((($0)) + 4|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = ($3|0)>(-65535);
 $spec$select = $4 ? $3 : -65535;
 $5 = HEAP32[$0>>2]|0;
 $6 = (($5) + ($spec$select)|0);
 $$0$copyload$i = HEAPU8[$6>>0]|(HEAPU8[$6+1>>0]<<8)|(HEAPU8[$6+2>>0]<<16)|(HEAPU8[$6+3>>0]<<24);
 $7 = (_offset_to_s32($spec$select)|0);
 $$02124 = 0;
 while(1) {
  $9 = (($1) + ($$02124<<2)|0);
  HEAP32[$9>>2] = $7;
  $10 = (((($1)) + 16|0) + ($$02124<<2)|0);
  HEAP32[$10>>2] = $$0$copyload$i;
  $11 = (($$02124) + 1)|0;
  $exitcond25 = ($11|0)==(4);
  if ($exitcond25) {
   break;
  } else {
   $$02124 = $11;
  }
 }
 $8 = ((($0)) + 60|0);
 $$023 = 0;
 while(1) {
  $12 = HEAP32[$8>>2]|0;
  $13 = (($12) + ($$023<<5)|0);
  ;HEAP32[$13>>2]=HEAP32[$1>>2]|0;HEAP32[$13+4>>2]=HEAP32[$1+4>>2]|0;HEAP32[$13+8>>2]=HEAP32[$1+8>>2]|0;HEAP32[$13+12>>2]=HEAP32[$1+12>>2]|0;HEAP32[$13+16>>2]=HEAP32[$1+16>>2]|0;HEAP32[$13+20>>2]=HEAP32[$1+20>>2]|0;HEAP32[$13+24>>2]=HEAP32[$1+24>>2]|0;HEAP32[$13+28>>2]=HEAP32[$1+28>>2]|0;
  $14 = (($$023) + 1)|0;
  $exitcond = ($14|0)==(16384);
  if ($exitcond) {
   break;
  } else {
   $$023 = $14;
  }
 }
 STACKTOP = sp;return;
}
function _lzvn_encode($0) {
 $0 = $0|0;
 var $$0$copyload$i = 0, $$byval_copy = 0, $$byval_copy1 = 0, $$byval_copy2 = 0, $$phi$trans$insert = 0, $$pre = 0, $$sroa$0$0 = 0, $$sroa$0$0$$sroa_idx23 = 0, $$sroa$0$0$copyload14 = 0, $$sroa$0$0$copyload16 = 0, $$sroa$0$0$copyload18 = 0, $$sroa$0$0$copyload20 = 0, $$sroa$0$0$copyload22 = 0, $$sroa$0$1 = 0, $$sroa$0$2 = 0, $$sroa$0$3 = 0, $$sroa$0$4 = 0, $$sroa$0$5 = 0, $$sroa$0108$0$$sroa_idx = 0, $$sroa$10$0 = 0;
 var $$sroa$10$0$$sroa_idx29 = 0, $$sroa$10$0$$sroa_idx31 = 0, $$sroa$10$0$$sroa_idx33 = 0, $$sroa$10$0$$sroa_idx35 = 0, $$sroa$10$0$$sroa_idx37 = 0, $$sroa$10$0$$sroa_idx39 = 0, $$sroa$10$0$copyload30 = 0, $$sroa$10$0$copyload30$pre = 0, $$sroa$10$0$copyload32 = 0, $$sroa$10$0$copyload32$pre = 0, $$sroa$10$0$copyload34 = 0, $$sroa$10$0$copyload34$pre = 0, $$sroa$10$0$copyload36 = 0, $$sroa$10$0$copyload36$pre = 0, $$sroa$10$0$copyload38 = 0, $$sroa$10$0$copyload38$pre = 0, $$sroa$10$1 = 0, $$sroa$10$2 = 0, $$sroa$10$3 = 0, $$sroa$10$4 = 0;
 var $$sroa$10$5 = 0, $$sroa$10122$0$$sroa_idx123 = 0, $$sroa$15$0 = 0, $$sroa$15$0$$sroa_idx49 = 0, $$sroa$15$0$$sroa_idx51 = 0, $$sroa$15$0$$sroa_idx53 = 0, $$sroa$15$0$$sroa_idx55 = 0, $$sroa$15$0$copyload50 = 0, $$sroa$15$0$copyload52 = 0, $$sroa$15$0$copyload54 = 0, $$sroa$15$0$copyload56 = 0, $$sroa$15$1 = 0, $$sroa$15$2 = 0, $$sroa$15$3 = 0, $$sroa$15$4 = 0, $$sroa$15$5 = 0, $$sroa$16$0 = 0, $$sroa$16$0$$sroa_idx65 = 0, $$sroa$16$0$$sroa_idx67 = 0, $$sroa$16$0$$sroa_idx69 = 0;
 var $$sroa$16$0$$sroa_idx71 = 0, $$sroa$16$0$$sroa_idx73 = 0, $$sroa$16$0$$sroa_idx75 = 0, $$sroa$16$0$copyload66 = 0, $$sroa$16$0$copyload68 = 0, $$sroa$16$0$copyload70 = 0, $$sroa$16$0$copyload72 = 0, $$sroa$16$0$copyload74 = 0, $$sroa$16$1 = 0, $$sroa$16$2 = 0, $$sroa$16$3 = 0, $$sroa$16$4 = 0, $$sroa$16$5 = 0, $$sroa$1681$0 = 0, $$sroa$1681$0$$sroa_idx92 = 0, $$sroa$1681$1 = 0, $$sroa$1681$2 = 0, $$sroa$1681$3 = 0, $$sroa$1681$4 = 0, $$sroa$1681$5 = 0;
 var $$sroa$4$0$$sroa_idx110 = 0, $$sroa$5$0$$sroa_idx112 = 0, $$sroa$6$0$$sroa_idx114 = 0, $$sroa$7$0$$sroa_idx116 = 0, $$sroa$8$0$$sroa_idx118 = 0, $$sroa$9$0$$sroa_idx120 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0;
 var $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0;
 var $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0;
 var $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0;
 var $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0;
 var $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0;
 var $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0;
 var $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0;
 var $97 = 0, $98 = 0, $99 = 0, $exitcond = 0, $or$cond = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 224|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(224|0);
 $$byval_copy2 = sp + 192|0;
 $$byval_copy1 = sp + 172|0;
 $$byval_copy = sp + 152|0;
 $1 = sp + 120|0;
 $2 = sp;
 $3 = sp + 96|0;
 $4 = sp + 76|0;
 $5 = sp + 56|0;
 $6 = sp + 36|0;
 $7 = sp + 16|0;
 $8 = ((($0)) + 12|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = ((($0)) + 16|0);
 $11 = HEAP32[$10>>2]|0;
 $12 = ($9|0)<($11|0);
 L1: do {
  if ($12) {
   $13 = ((($0)) + 60|0);
   $14 = ((($1)) + 4|0);
   $15 = ((($1)) + 8|0);
   $16 = ((($1)) + 16|0);
   $17 = ((($1)) + 20|0);
   $18 = ((($1)) + 24|0);
   $19 = ((($0)) + 20|0);
   $20 = ((($0)) + 4|0);
   $21 = ((($0)) + 8|0);
   $22 = ((($2)) + 4|0);
   $23 = ((($3)) + 16|0);
   $24 = ((($2)) + 8|0);
   $25 = ((($4)) + 16|0);
   $$sroa$10$0$$sroa_idx29 = ((($3)) + 4|0);
   $$sroa$15$0$$sroa_idx49 = ((($3)) + 8|0);
   $$sroa$16$0$$sroa_idx65 = ((($3)) + 12|0);
   $26 = ((($1)) + 12|0);
   $27 = ((($2)) + 12|0);
   $28 = ((($5)) + 16|0);
   $$sroa$10$0$$sroa_idx31 = ((($4)) + 4|0);
   $$sroa$15$0$$sroa_idx51 = ((($4)) + 8|0);
   $$sroa$16$0$$sroa_idx67 = ((($4)) + 12|0);
   $29 = ((($0)) + 56|0);
   $30 = ((($6)) + 16|0);
   $$sroa$10$0$$sroa_idx33 = ((($5)) + 4|0);
   $$sroa$15$0$$sroa_idx53 = ((($5)) + 8|0);
   $$sroa$16$0$$sroa_idx69 = ((($5)) + 12|0);
   $$sroa$10$0$$sroa_idx35 = ((($6)) + 4|0);
   $$sroa$15$0$$sroa_idx55 = ((($6)) + 8|0);
   $$sroa$16$0$$sroa_idx71 = ((($6)) + 12|0);
   $31 = ((($0)) + 36|0);
   $32 = ((($0)) + 44|0);
   $33 = ((($7)) + 8|0);
   $34 = ((($7)) + 16|0);
   $$sroa$0$0$$sroa_idx23 = ((($0)) + 36|0);
   $$sroa$10$0$$sroa_idx39 = ((($0)) + 40|0);
   $$sroa$16$0$$sroa_idx75 = ((($0)) + 48|0);
   $$sroa$1681$0$$sroa_idx92 = ((($0)) + 52|0);
   $$sroa$10$0$$sroa_idx37 = ((($7)) + 4|0);
   $$sroa$16$0$$sroa_idx73 = ((($7)) + 12|0);
   $37 = $9;
   L3: while(1) {
    $35 = HEAP32[$0>>2]|0;
    $36 = (($35) + ($37)|0);
    $$0$copyload$i = HEAPU8[$36>>0]|(HEAPU8[$36+1>>0]<<8)|(HEAPU8[$36+2>>0]<<16)|(HEAPU8[$36+3>>0]<<24);
    $38 = (_hash3i($$0$copyload$i)|0);
    $39 = HEAP32[$13>>2]|0;
    $40 = (($39) + ($38<<5)|0);
    ;HEAP32[$1>>2]=HEAP32[$40>>2]|0;HEAP32[$1+4>>2]=HEAP32[$40+4>>2]|0;HEAP32[$1+8>>2]=HEAP32[$40+8>>2]|0;HEAP32[$1+12>>2]=HEAP32[$40+12>>2]|0;HEAP32[$1+16>>2]=HEAP32[$40+16>>2]|0;HEAP32[$1+20>>2]=HEAP32[$40+20>>2]|0;HEAP32[$1+24>>2]=HEAP32[$40+24>>2]|0;HEAP32[$1+28>>2]=HEAP32[$40+28>>2]|0;
    $41 = HEAP32[$1>>2]|0;
    $42 = HEAP32[$14>>2]|0;
    $43 = HEAP32[$15>>2]|0;
    $44 = HEAP32[$16>>2]|0;
    $45 = HEAP32[$17>>2]|0;
    $46 = HEAP32[$18>>2]|0;
    $47 = HEAP32[$19>>2]|0;
    $48 = ($37|0)<($47|0);
    do {
     if (!($48)) {
      $49 = $44 ^ $$0$copyload$i;
      HEAP32[$2>>2] = $49;
      $57 = 1;
      while(1) {
       $$phi$trans$insert = (((($1)) + 16|0) + ($57<<2)|0);
       $$pre = HEAP32[$$phi$trans$insert>>2]|0;
       $58 = $$pre ^ $$0$copyload$i;
       $59 = (($2) + ($57<<2)|0);
       HEAP32[$59>>2] = $58;
       $60 = (($57) + 1)|0;
       $exitcond = ($60|0)==(4);
       if ($exitcond) {
        break;
       } else {
        $57 = $60;
       }
      }
      $50 = (_offset_from_s32($41)|0);
      $51 = HEAP32[$2>>2]|0;
      $52 = (_trailing_zero_bytes($51)|0);
      $53 = HEAP32[$20>>2]|0;
      $54 = HEAP32[$21>>2]|0;
      $55 = (_lzvn_find_matchN($35,$53,$54,$47,$50,$37,$52,$3)|0);
      $56 = ($55|0)==(0);
      do {
       if ($56) {
        $$sroa$0$0 = 0;$$sroa$10$0 = 0;$$sroa$15$0 = 0;$$sroa$16$0 = 0;$$sroa$1681$0 = 0;
       } else {
        $61 = HEAP32[$23>>2]|0;
        $62 = ($61|0)>(0);
        if ($62) {
         $$sroa$10$0$copyload30$pre = HEAP32[$$sroa$10$0$$sroa_idx29>>2]|0;
         $$sroa$10$0$copyload30 = $$sroa$10$0$copyload30$pre;
        } else {
         $63 = ($61|0)==(0);
         $64 = HEAP32[$$sroa$10$0$$sroa_idx29>>2]|0;
         $65 = ($64|0)>(1);
         $or$cond = $63 & $65;
         if ($or$cond) {
          $$sroa$10$0$copyload30 = $64;
         } else {
          $$sroa$0$0 = 0;$$sroa$10$0 = 0;$$sroa$15$0 = 0;$$sroa$16$0 = 0;$$sroa$1681$0 = 0;
          break;
         }
        }
        $$sroa$0$0$copyload14 = HEAP32[$3>>2]|0;
        $$sroa$15$0$copyload50 = HEAP32[$$sroa$15$0$$sroa_idx49>>2]|0;
        $$sroa$16$0$copyload66 = HEAP32[$$sroa$16$0$$sroa_idx65>>2]|0;
        $$sroa$0$0 = $$sroa$0$0$copyload14;$$sroa$10$0 = $$sroa$10$0$copyload30;$$sroa$15$0 = $$sroa$15$0$copyload50;$$sroa$16$0 = $$sroa$16$0$copyload66;$$sroa$1681$0 = $61;
       }
      } while(0);
      $66 = (_offset_from_s32($42)|0);
      $67 = HEAP32[$22>>2]|0;
      $68 = (_trailing_zero_bytes($67)|0);
      $69 = HEAP32[$0>>2]|0;
      $70 = HEAP32[$20>>2]|0;
      $71 = HEAP32[$21>>2]|0;
      $72 = HEAP32[$19>>2]|0;
      $73 = HEAP32[$8>>2]|0;
      $74 = (_lzvn_find_matchN($69,$70,$71,$72,$66,$73,$68,$4)|0);
      $75 = ($74|0)==(0);
      do {
       if ($75) {
        $$sroa$0$1 = $$sroa$0$0;$$sroa$10$1 = $$sroa$10$0;$$sroa$15$1 = $$sroa$15$0;$$sroa$16$1 = $$sroa$16$0;$$sroa$1681$1 = $$sroa$1681$0;
       } else {
        $76 = HEAP32[$25>>2]|0;
        $77 = ($76|0)>($$sroa$1681$0|0);
        if ($77) {
         $$sroa$10$0$copyload32$pre = HEAP32[$$sroa$10$0$$sroa_idx31>>2]|0;
         $$sroa$10$0$copyload32 = $$sroa$10$0$copyload32$pre;
        } else {
         $78 = ($76|0)==($$sroa$1681$0|0);
         if (!($78)) {
          $$sroa$0$1 = $$sroa$0$0;$$sroa$10$1 = $$sroa$10$0;$$sroa$15$1 = $$sroa$15$0;$$sroa$16$1 = $$sroa$16$0;$$sroa$1681$1 = $$sroa$1681$0;
          break;
         }
         $79 = HEAP32[$$sroa$10$0$$sroa_idx31>>2]|0;
         $80 = (($$sroa$10$0) + 1)|0;
         $81 = ($79|0)>($80|0);
         if ($81) {
          $$sroa$10$0$copyload32 = $79;
         } else {
          $$sroa$0$1 = $$sroa$0$0;$$sroa$10$1 = $$sroa$10$0;$$sroa$15$1 = $$sroa$15$0;$$sroa$16$1 = $$sroa$16$0;$$sroa$1681$1 = $$sroa$1681$0;
          break;
         }
        }
        $$sroa$0$0$copyload16 = HEAP32[$4>>2]|0;
        $$sroa$15$0$copyload52 = HEAP32[$$sroa$15$0$$sroa_idx51>>2]|0;
        $$sroa$16$0$copyload68 = HEAP32[$$sroa$16$0$$sroa_idx67>>2]|0;
        $$sroa$0$1 = $$sroa$0$0$copyload16;$$sroa$10$1 = $$sroa$10$0$copyload32;$$sroa$15$1 = $$sroa$15$0$copyload52;$$sroa$16$1 = $$sroa$16$0$copyload68;$$sroa$1681$1 = $76;
       }
      } while(0);
      $82 = (_offset_from_s32($43)|0);
      $83 = HEAP32[$24>>2]|0;
      $84 = (_trailing_zero_bytes($83)|0);
      $85 = HEAP32[$0>>2]|0;
      $86 = HEAP32[$20>>2]|0;
      $87 = HEAP32[$21>>2]|0;
      $88 = HEAP32[$19>>2]|0;
      $89 = HEAP32[$8>>2]|0;
      $90 = (_lzvn_find_matchN($85,$86,$87,$88,$82,$89,$84,$5)|0);
      $91 = ($90|0)==(0);
      do {
       if ($91) {
        $$sroa$0$2 = $$sroa$0$1;$$sroa$10$2 = $$sroa$10$1;$$sroa$15$2 = $$sroa$15$1;$$sroa$16$2 = $$sroa$16$1;$$sroa$1681$2 = $$sroa$1681$1;
       } else {
        $92 = HEAP32[$28>>2]|0;
        $93 = ($92|0)>($$sroa$1681$1|0);
        if ($93) {
         $$sroa$10$0$copyload34$pre = HEAP32[$$sroa$10$0$$sroa_idx33>>2]|0;
         $$sroa$10$0$copyload34 = $$sroa$10$0$copyload34$pre;
        } else {
         $94 = ($92|0)==($$sroa$1681$1|0);
         if (!($94)) {
          $$sroa$0$2 = $$sroa$0$1;$$sroa$10$2 = $$sroa$10$1;$$sroa$15$2 = $$sroa$15$1;$$sroa$16$2 = $$sroa$16$1;$$sroa$1681$2 = $$sroa$1681$1;
          break;
         }
         $95 = HEAP32[$$sroa$10$0$$sroa_idx33>>2]|0;
         $96 = (($$sroa$10$1) + 1)|0;
         $97 = ($95|0)>($96|0);
         if ($97) {
          $$sroa$10$0$copyload34 = $95;
         } else {
          $$sroa$0$2 = $$sroa$0$1;$$sroa$10$2 = $$sroa$10$1;$$sroa$15$2 = $$sroa$15$1;$$sroa$16$2 = $$sroa$16$1;$$sroa$1681$2 = $$sroa$1681$1;
          break;
         }
        }
        $$sroa$0$0$copyload18 = HEAP32[$5>>2]|0;
        $$sroa$15$0$copyload54 = HEAP32[$$sroa$15$0$$sroa_idx53>>2]|0;
        $$sroa$16$0$copyload70 = HEAP32[$$sroa$16$0$$sroa_idx69>>2]|0;
        $$sroa$0$2 = $$sroa$0$0$copyload18;$$sroa$10$2 = $$sroa$10$0$copyload34;$$sroa$15$2 = $$sroa$15$0$copyload54;$$sroa$16$2 = $$sroa$16$0$copyload70;$$sroa$1681$2 = $92;
       }
      } while(0);
      $98 = HEAP32[$26>>2]|0;
      $99 = (_offset_from_s32($98)|0);
      $100 = HEAP32[$27>>2]|0;
      $101 = (_trailing_zero_bytes($100)|0);
      $102 = HEAP32[$0>>2]|0;
      $103 = HEAP32[$20>>2]|0;
      $104 = HEAP32[$21>>2]|0;
      $105 = HEAP32[$19>>2]|0;
      $106 = HEAP32[$8>>2]|0;
      $107 = (_lzvn_find_matchN($102,$103,$104,$105,$99,$106,$101,$6)|0);
      $108 = ($107|0)==(0);
      do {
       if ($108) {
        $$sroa$0$3 = $$sroa$0$2;$$sroa$10$3 = $$sroa$10$2;$$sroa$15$3 = $$sroa$15$2;$$sroa$16$3 = $$sroa$16$2;$$sroa$1681$3 = $$sroa$1681$2;
       } else {
        $109 = HEAP32[$30>>2]|0;
        $110 = ($109|0)>($$sroa$1681$2|0);
        if ($110) {
         $$sroa$10$0$copyload36$pre = HEAP32[$$sroa$10$0$$sroa_idx35>>2]|0;
         $$sroa$10$0$copyload36 = $$sroa$10$0$copyload36$pre;
        } else {
         $111 = ($109|0)==($$sroa$1681$2|0);
         if (!($111)) {
          $$sroa$0$3 = $$sroa$0$2;$$sroa$10$3 = $$sroa$10$2;$$sroa$15$3 = $$sroa$15$2;$$sroa$16$3 = $$sroa$16$2;$$sroa$1681$3 = $$sroa$1681$2;
          break;
         }
         $112 = HEAP32[$$sroa$10$0$$sroa_idx35>>2]|0;
         $113 = (($$sroa$10$2) + 1)|0;
         $114 = ($112|0)>($113|0);
         if ($114) {
          $$sroa$10$0$copyload36 = $112;
         } else {
          $$sroa$0$3 = $$sroa$0$2;$$sroa$10$3 = $$sroa$10$2;$$sroa$15$3 = $$sroa$15$2;$$sroa$16$3 = $$sroa$16$2;$$sroa$1681$3 = $$sroa$1681$2;
          break;
         }
        }
        $$sroa$0$0$copyload20 = HEAP32[$6>>2]|0;
        $$sroa$15$0$copyload56 = HEAP32[$$sroa$15$0$$sroa_idx55>>2]|0;
        $$sroa$16$0$copyload72 = HEAP32[$$sroa$16$0$$sroa_idx71>>2]|0;
        $$sroa$0$3 = $$sroa$0$0$copyload20;$$sroa$10$3 = $$sroa$10$0$copyload36;$$sroa$15$3 = $$sroa$15$0$copyload56;$$sroa$16$3 = $$sroa$16$0$copyload72;$$sroa$1681$3 = $109;
       }
      } while(0);
      $115 = HEAP32[$29>>2]|0;
      $116 = ($115|0)==(0);
      if ($116) {
       $$sroa$0$5 = $$sroa$0$3;$$sroa$10$5 = $$sroa$10$3;$$sroa$15$5 = $$sroa$15$3;$$sroa$16$5 = $$sroa$16$3;$$sroa$1681$5 = $$sroa$1681$3;
      } else {
       $117 = HEAP32[$0>>2]|0;
       $118 = HEAP32[$20>>2]|0;
       $119 = HEAP32[$21>>2]|0;
       $120 = HEAP32[$19>>2]|0;
       $121 = HEAP32[$8>>2]|0;
       $122 = (($121) - ($115))|0;
       $123 = (_lzvn_find_match($117,$118,$119,$120,$122,$121,$7)|0);
       $124 = ($123|0)==(0);
       do {
        if ($124) {
         $$sroa$0$4 = $$sroa$0$3;$$sroa$10$4 = $$sroa$10$3;$$sroa$15$4 = $$sroa$15$3;$$sroa$16$4 = $$sroa$16$3;$$sroa$1681$4 = $$sroa$1681$3;
        } else {
         $125 = HEAP32[$33>>2]|0;
         $126 = (($125) + -1)|0;
         HEAP32[$34>>2] = $126;
         $127 = ($126|0)>($$sroa$1681$3|0);
         if ($127) {
          $$sroa$10$0$copyload38$pre = HEAP32[$$sroa$10$0$$sroa_idx37>>2]|0;
          $$sroa$10$0$copyload38 = $$sroa$10$0$copyload38$pre;
         } else {
          $128 = ($126|0)==($$sroa$1681$3|0);
          if (!($128)) {
           $$sroa$0$4 = $$sroa$0$3;$$sroa$10$4 = $$sroa$10$3;$$sroa$15$4 = $$sroa$15$3;$$sroa$16$4 = $$sroa$16$3;$$sroa$1681$4 = $$sroa$1681$3;
           break;
          }
          $129 = HEAP32[$$sroa$10$0$$sroa_idx37>>2]|0;
          $130 = (($$sroa$10$3) + 1)|0;
          $131 = ($129|0)>($130|0);
          if ($131) {
           $$sroa$10$0$copyload38 = $129;
          } else {
           $$sroa$0$4 = $$sroa$0$3;$$sroa$10$4 = $$sroa$10$3;$$sroa$15$4 = $$sroa$15$3;$$sroa$16$4 = $$sroa$16$3;$$sroa$1681$4 = $$sroa$1681$3;
           break;
          }
         }
         $$sroa$0$0$copyload22 = HEAP32[$7>>2]|0;
         $$sroa$16$0$copyload74 = HEAP32[$$sroa$16$0$$sroa_idx73>>2]|0;
         $$sroa$0$4 = $$sroa$0$0$copyload22;$$sroa$10$4 = $$sroa$10$0$copyload38;$$sroa$15$4 = $125;$$sroa$16$4 = $$sroa$16$0$copyload74;$$sroa$1681$4 = $126;
        }
       } while(0);
       $$sroa$0$5 = $$sroa$0$4;$$sroa$10$5 = $$sroa$10$4;$$sroa$15$5 = $$sroa$15$4;$$sroa$16$5 = $$sroa$16$4;$$sroa$1681$5 = $$sroa$1681$4;
      }
      $132 = ($$sroa$15$5|0)==(0);
      if ($132) {
       $133 = HEAP32[$8>>2]|0;
       $134 = HEAP32[$19>>2]|0;
       $135 = (($133) - ($134))|0;
       $136 = ($135|0)>(399);
       if (!($136)) {
        break;
       }
       $137 = HEAP32[$32>>2]|0;
       $138 = ($137|0)==(0);
       if ($138) {
        $141 = (_lzvn_emit_literal($0,271)|0);
        $142 = ($141|0)==(0);
        if ($142) {
         break L3;
        } else {
         break;
        }
       }
       ;HEAP32[$$byval_copy>>2]=HEAP32[$31>>2]|0;HEAP32[$$byval_copy+4>>2]=HEAP32[$31+4>>2]|0;HEAP32[$$byval_copy+8>>2]=HEAP32[$31+8>>2]|0;HEAP32[$$byval_copy+12>>2]=HEAP32[$31+12>>2]|0;HEAP32[$$byval_copy+16>>2]=HEAP32[$31+16>>2]|0;
       $139 = (_lzvn_emit_match($0,$$byval_copy)|0);
       $140 = ($139|0)==(0);
       if ($140) {
        break L3;
       }
       ;HEAP32[$31>>2]=0|0;HEAP32[$31+4>>2]=0|0;HEAP32[$31+8>>2]=0|0;HEAP32[$31+12>>2]=0|0;HEAP32[$31+16>>2]=0|0;
       break;
      }
      $143 = HEAP32[$32>>2]|0;
      $144 = ($143|0)==(0);
      if ($144) {
       HEAP32[$$sroa$0$0$$sroa_idx23>>2] = $$sroa$0$5;
       HEAP32[$$sroa$10$0$$sroa_idx39>>2] = $$sroa$10$5;
       HEAP32[$32>>2] = $$sroa$15$5;
       HEAP32[$$sroa$16$0$$sroa_idx75>>2] = $$sroa$16$5;
       HEAP32[$$sroa$1681$0$$sroa_idx92>>2] = $$sroa$1681$5;
       break;
      }
      $145 = HEAP32[$$sroa$10$0$$sroa_idx39>>2]|0;
      $146 = ($145|0)>($$sroa$0$5|0);
      if (!($146)) {
       ;HEAP32[$$byval_copy1>>2]=HEAP32[$31>>2]|0;HEAP32[$$byval_copy1+4>>2]=HEAP32[$31+4>>2]|0;HEAP32[$$byval_copy1+8>>2]=HEAP32[$31+8>>2]|0;HEAP32[$$byval_copy1+12>>2]=HEAP32[$31+12>>2]|0;HEAP32[$$byval_copy1+16>>2]=HEAP32[$31+16>>2]|0;
       $147 = (_lzvn_emit_match($0,$$byval_copy1)|0);
       $148 = ($147|0)==(0);
       if ($148) {
        break L3;
       }
       HEAP32[$$sroa$0$0$$sroa_idx23>>2] = $$sroa$0$5;
       HEAP32[$$sroa$10$0$$sroa_idx39>>2] = $$sroa$10$5;
       HEAP32[$32>>2] = $$sroa$15$5;
       HEAP32[$$sroa$16$0$$sroa_idx75>>2] = $$sroa$16$5;
       HEAP32[$$sroa$1681$0$$sroa_idx92>>2] = $$sroa$1681$5;
       break;
      }
      $149 = HEAP32[$$sroa$1681$0$$sroa_idx92>>2]|0;
      $150 = ($$sroa$1681$5|0)>($149|0);
      if ($150) {
       HEAP32[$$sroa$0$0$$sroa_idx23>>2] = $$sroa$0$5;
       HEAP32[$$sroa$10$0$$sroa_idx39>>2] = $$sroa$10$5;
       HEAP32[$32>>2] = $$sroa$15$5;
       HEAP32[$$sroa$16$0$$sroa_idx75>>2] = $$sroa$16$5;
       HEAP32[$$sroa$1681$0$$sroa_idx92>>2] = $$sroa$1681$5;
      }
      ;HEAP32[$$byval_copy2>>2]=HEAP32[$31>>2]|0;HEAP32[$$byval_copy2+4>>2]=HEAP32[$31+4>>2]|0;HEAP32[$$byval_copy2+8>>2]=HEAP32[$31+8>>2]|0;HEAP32[$$byval_copy2+12>>2]=HEAP32[$31+12>>2]|0;HEAP32[$$byval_copy2+16>>2]=HEAP32[$31+16>>2]|0;
      $151 = (_lzvn_emit_match($0,$$byval_copy2)|0);
      $152 = ($151|0)==(0);
      if ($152) {
       break L3;
      }
      ;HEAP32[$31>>2]=0|0;HEAP32[$31+4>>2]=0|0;HEAP32[$31+8>>2]=0|0;HEAP32[$31+12>>2]=0|0;HEAP32[$31+16>>2]=0|0;
     }
    } while(0);
    $153 = HEAP32[$13>>2]|0;
    $$sroa$0108$0$$sroa_idx = (($153) + ($38<<5)|0);
    HEAP32[$$sroa$0108$0$$sroa_idx>>2] = $37;
    $$sroa$4$0$$sroa_idx110 = (((($153) + ($38<<5)|0)) + 4|0);
    HEAP32[$$sroa$4$0$$sroa_idx110>>2] = $41;
    $$sroa$5$0$$sroa_idx112 = (((($153) + ($38<<5)|0)) + 8|0);
    HEAP32[$$sroa$5$0$$sroa_idx112>>2] = $42;
    $$sroa$6$0$$sroa_idx114 = (((($153) + ($38<<5)|0)) + 12|0);
    HEAP32[$$sroa$6$0$$sroa_idx114>>2] = $43;
    $$sroa$7$0$$sroa_idx116 = (((($153) + ($38<<5)|0)) + 16|0);
    HEAP32[$$sroa$7$0$$sroa_idx116>>2] = $$0$copyload$i;
    $$sroa$8$0$$sroa_idx118 = (((($153) + ($38<<5)|0)) + 20|0);
    HEAP32[$$sroa$8$0$$sroa_idx118>>2] = $44;
    $$sroa$9$0$$sroa_idx120 = (((($153) + ($38<<5)|0)) + 24|0);
    HEAP32[$$sroa$9$0$$sroa_idx120>>2] = $45;
    $$sroa$10122$0$$sroa_idx123 = (((($153) + ($38<<5)|0)) + 28|0);
    HEAP32[$$sroa$10122$0$$sroa_idx123>>2] = $46;
    $154 = HEAP32[$8>>2]|0;
    $155 = (($154) + 1)|0;
    HEAP32[$8>>2] = $155;
    $156 = HEAP32[$10>>2]|0;
    $157 = ($155|0)<($156|0);
    if ($157) {
     $37 = $155;
    } else {
     break L1;
    }
   }
  }
 } while(0);
 STACKTOP = sp;return;
}
function _lzvn_emit_literal($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = HEAP32[$0>>2]|0;
 $3 = ((($0)) + 20|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = (($2) + ($4)|0);
 $6 = ((($0)) + 24|0);
 $7 = HEAP32[$6>>2]|0;
 $8 = ((($0)) + 32|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = (_emit_literal($5,$7,$9,$1)|0);
 $11 = HEAP32[$8>>2]|0;
 $12 = ($10>>>0)<($11>>>0);
 if ($12) {
  $13 = HEAP32[$6>>2]|0;
  $14 = $10;
  $15 = (($14) - ($13))|0;
  HEAP32[$6>>2] = $10;
  $16 = HEAP32[$3>>2]|0;
  $17 = (($16) + ($1))|0;
  HEAP32[$3>>2] = $17;
  $$0 = $15;
 } else {
  $$0 = 0;
 }
 return ($$0|0);
}
function _lzvn_emit_end_of_stream($0) {
 $0 = $0|0;
 var $1 = 0, $10 = 0, $11 = 0, $12 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 32|0);
 $2 = HEAP32[$1>>2]|0;
 $3 = ((($0)) + 24|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = ((($4)) + 8|0);
 $6 = ($2>>>0)<($5>>>0);
 if (!($6)) {
  $7 = $4;
  $8 = $7;
  HEAP8[$8>>0]=6&255;HEAP8[$8+1>>0]=(6>>8)&255;HEAP8[$8+2>>0]=(6>>16)&255;HEAP8[$8+3>>0]=6>>24;
  $9 = (($7) + 4)|0;
  $10 = $9;
  HEAP8[$10>>0]=0&255;HEAP8[$10+1>>0]=(0>>8)&255;HEAP8[$10+2>>0]=(0>>16)&255;HEAP8[$10+3>>0]=0>>24;
  $11 = HEAP32[$3>>2]|0;
  $12 = ((($11)) + 8|0);
  HEAP32[$3>>2] = $12;
 }
 return;
}
function _emit_literal($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$0 = 0, $$027$lcssa = 0, $$02735 = 0, $$028$lcssa = 0, $$02834 = 0, $$029$lcssa = 0, $$02933 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0;
 var $23 = 0, $24 = 0, $25 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = ($3>>>0)>(15);
 L1: do {
  if ($4) {
   $$02735 = $3;$$02834 = $0;$$02933 = $1;
   while(1) {
    $5 = ($$02735>>>0)<(271);
    $6 = $5 ? $$02735 : 271;
    $7 = (($$02933) + ($6)|0);
    $8 = ((($7)) + 10|0);
    $9 = ($8>>>0)<($2>>>0);
    if (!($9)) {
     $$0 = $2;
     break L1;
    }
    $10 = $6 << 8;
    $11 = (($10) + 61664)|0;
    $12 = $11&65535;
    HEAP8[$$02933>>0]=$12&255;HEAP8[$$02933+1>>0]=$12>>8;
    $13 = ((($$02933)) + 2|0);
    $14 = (($$02735) - ($6))|0;
    $15 = (_lzvn_copy8($13,$$02834,$6)|0);
    $16 = (($$02834) + ($6)|0);
    $17 = ($14>>>0)>(15);
    if ($17) {
     $$02735 = $14;$$02834 = $16;$$02933 = $15;
    } else {
     $$027$lcssa = $14;$$028$lcssa = $16;$$029$lcssa = $15;
     label = 5;
     break;
    }
   }
  } else {
   $$027$lcssa = $3;$$028$lcssa = $0;$$029$lcssa = $1;
   label = 5;
  }
 } while(0);
 if ((label|0) == 5) {
  $18 = ($$027$lcssa|0)==(0);
  if ($18) {
   $$0 = $$029$lcssa;
  } else {
   $19 = (($$029$lcssa) + ($$027$lcssa)|0);
   $20 = ((($19)) + 10|0);
   $21 = ($20>>>0)<($2>>>0);
   if ($21) {
    $22 = ((($$029$lcssa)) + 1|0);
    $23 = (($$027$lcssa) + 224)|0;
    $24 = $23&255;
    HEAP8[$$029$lcssa>>0] = $24;
    $25 = (_lzvn_copy8($22,$$028$lcssa,$$027$lcssa)|0);
    $$0 = $25;
   } else {
    $$0 = $2;
   }
  }
 }
 return ($$0|0);
}
function _lzvn_copy8($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $3 = 0, $4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ($2|0)==(0);
 if (!($3)) {
  _memcpy(($0|0),($1|0),($2|0))|0;
 }
 $4 = (($0) + ($2)|0);
 return ($4|0);
}
function _hash3i($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = $0 & 16777215;
 $2 = ($1*4161)|0;
 $3 = $2 >>> 12;
 $4 = $3 & 16383;
 return ($4|0);
}
function _offset_from_s32($0) {
 $0 = $0|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return ($0|0);
}
function _trailing_zero_bytes($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, $spec$select = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ($0|0)==(0);
 $2 = (_llvm_cttz_i32(($0|0))|0);
 $3 = $2 >>> 3;
 $spec$select = $1 ? 4 : $3;
 return ($spec$select|0);
}
function _lzvn_find_matchN($0,$1,$2,$3,$4,$5,$6,$7) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 $6 = $6|0;
 $7 = $7|0;
 var $$047$lcssa = 0, $$04759 = 0, $$04855 = 0, $$049$lcssa = 0, $$04954 = 0, $$1 = 0, $$off = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0;
 var $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $8 = 0, $9 = 0, $or$cond = 0;
 var $or$cond52 = 0, $or$cond5253 = 0, $or$cond58 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $8 = ($6|0)<(3);
 if ($8) {
  $$1 = 0;
 } else {
  $9 = (($5) - ($4))|0;
  $$off = (($9) + -1)|0;
  $10 = ($$off>>>0)>(65534);
  if ($10) {
   $$1 = 0;
  } else {
   $11 = (($6) + ($5))|0;
   $12 = ($6|0)==(4);
   $13 = (($11) + 4)|0;
   $14 = ($13|0)<($2|0);
   $or$cond58 = $12 & $14;
   if ($or$cond58) {
    $$04759 = $11;
    while(1) {
     $15 = (($$04759) - ($9))|0;
     $16 = (_nmatch4($0,$$04759,$15)|0);
     $17 = (($16) + ($$04759))|0;
     $18 = ($16|0)==(4);
     $19 = (($17) + 4)|0;
     $20 = ($19|0)<($2|0);
     $or$cond = $18 & $20;
     if ($or$cond) {
      $$04759 = $17;
     } else {
      $$047$lcssa = $17;
      break;
     }
    }
   } else {
    $$047$lcssa = $11;
   }
   $21 = ($4|0)>($1|0);
   $22 = ($5|0)>($3|0);
   $or$cond5253 = $22 & $21;
   L9: do {
    if ($or$cond5253) {
     $$04855 = $4;$$04954 = $5;
     while(1) {
      $26 = (($$04954) + -1)|0;
      $27 = (($0) + ($26)|0);
      $28 = HEAP8[$27>>0]|0;
      $24 = (($$04855) + -1)|0;
      $29 = (($0) + ($24)|0);
      $30 = HEAP8[$29>>0]|0;
      $31 = ($28<<24>>24)==($30<<24>>24);
      if (!($31)) {
       $$049$lcssa = $$04954;
       break L9;
      }
      $23 = ($24|0)>($1|0);
      $25 = ($26|0)>($3|0);
      $or$cond52 = $25 & $23;
      if ($or$cond52) {
       $$04855 = $24;$$04954 = $26;
      } else {
       $$049$lcssa = $26;
       break;
      }
     }
    } else {
     $$049$lcssa = $5;
    }
   } while(0);
   $32 = (($$047$lcssa) - ($$049$lcssa))|0;
   HEAP32[$7>>2] = $$049$lcssa;
   $33 = ((($7)) + 4|0);
   HEAP32[$33>>2] = $$047$lcssa;
   $34 = ($9|0)<(1536);
   $35 = $34 ? 2 : 3;
   $36 = (($32) - ($35))|0;
   $37 = ((($7)) + 16|0);
   HEAP32[$37>>2] = $36;
   $38 = ((($7)) + 8|0);
   HEAP32[$38>>2] = $32;
   $39 = ((($7)) + 12|0);
   HEAP32[$39>>2] = $9;
   $$1 = 1;
  }
 }
 return ($$1|0);
}
function _lzvn_find_match($0,$1,$2,$3,$4,$5,$6) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 $6 = $6|0;
 var $$052$lcssa = 0, $$05264 = 0, $$05360 = 0, $$055$lcssa = 0, $$05559 = 0, $$1 = 0, $$off = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0;
 var $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $7 = 0, $8 = 0, $9 = 0;
 var $or$cond = 0, $or$cond57 = 0, $or$cond5758 = 0, $or$cond63 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $7 = (_nmatch4($0,$5,$4)|0);
 $8 = ($7|0)<(3);
 if ($8) {
  $$1 = 0;
 } else {
  $9 = (($5) - ($4))|0;
  $$off = (($9) + -1)|0;
  $10 = ($$off>>>0)>(65534);
  if ($10) {
   $$1 = 0;
  } else {
   $11 = (($7) + ($5))|0;
   $12 = ($7|0)==(4);
   $13 = (($11) + 4)|0;
   $14 = ($13|0)<($2|0);
   $or$cond63 = $12 & $14;
   if ($or$cond63) {
    $$05264 = $11;
    while(1) {
     $15 = (($$05264) - ($9))|0;
     $16 = (_nmatch4($0,$$05264,$15)|0);
     $17 = (($16) + ($$05264))|0;
     $18 = ($16|0)==(4);
     $19 = (($17) + 4)|0;
     $20 = ($19|0)<($2|0);
     $or$cond = $18 & $20;
     if ($or$cond) {
      $$05264 = $17;
     } else {
      $$052$lcssa = $17;
      break;
     }
    }
   } else {
    $$052$lcssa = $11;
   }
   $21 = ($4|0)>($1|0);
   $22 = ($5|0)>($3|0);
   $or$cond5758 = $22 & $21;
   L9: do {
    if ($or$cond5758) {
     $$05360 = $4;$$05559 = $5;
     while(1) {
      $26 = (($$05559) + -1)|0;
      $27 = (($0) + ($26)|0);
      $28 = HEAP8[$27>>0]|0;
      $24 = (($$05360) + -1)|0;
      $29 = (($0) + ($24)|0);
      $30 = HEAP8[$29>>0]|0;
      $31 = ($28<<24>>24)==($30<<24>>24);
      if (!($31)) {
       $$055$lcssa = $$05559;
       break L9;
      }
      $23 = ($24|0)>($1|0);
      $25 = ($26|0)>($3|0);
      $or$cond57 = $25 & $23;
      if ($or$cond57) {
       $$05360 = $24;$$05559 = $26;
      } else {
       $$055$lcssa = $26;
       break;
      }
     }
    } else {
     $$055$lcssa = $5;
    }
   } while(0);
   $32 = (($$052$lcssa) - ($$055$lcssa))|0;
   HEAP32[$6>>2] = $$055$lcssa;
   $33 = ((($6)) + 4|0);
   HEAP32[$33>>2] = $$052$lcssa;
   $34 = ($9|0)<(1536);
   $35 = $34 ? 2 : 3;
   $36 = (($32) - ($35))|0;
   $37 = ((($6)) + 16|0);
   HEAP32[$37>>2] = $36;
   $38 = ((($6)) + 8|0);
   HEAP32[$38>>2] = $32;
   $39 = ((($6)) + 12|0);
   HEAP32[$39>>2] = $9;
   $$1 = 1;
  }
 }
 return ($$1|0);
}
function _lzvn_emit_match($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $3 = 0, $4 = 0;
 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = HEAP32[$1>>2]|0;
 $3 = ((($0)) + 20|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = (($2) - ($4))|0;
 $6 = ((($1)) + 8|0);
 $7 = HEAP32[$6>>2]|0;
 $8 = ((($1)) + 12|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = ((($0)) + 56|0);
 $11 = HEAP32[$10>>2]|0;
 $12 = HEAP32[$0>>2]|0;
 $13 = (($12) + ($4)|0);
 $14 = ((($0)) + 24|0);
 $15 = HEAP32[$14>>2]|0;
 $16 = ((($0)) + 32|0);
 $17 = HEAP32[$16>>2]|0;
 $18 = (_emit($13,$15,$17,$5,$7,$9,$11)|0);
 $19 = HEAP32[$16>>2]|0;
 $20 = ($18>>>0)<($19>>>0);
 if ($20) {
  $21 = HEAP32[$14>>2]|0;
  $22 = $18;
  $23 = (($22) - ($21))|0;
  HEAP32[$10>>2] = $9;
  HEAP32[$14>>2] = $18;
  $24 = ((($1)) + 4|0);
  $25 = HEAP32[$24>>2]|0;
  HEAP32[$3>>2] = $25;
  $$0 = $23;
 } else {
  $$0 = 0;
 }
 return ($$0|0);
}
function _emit($0,$1,$2,$3,$4,$5,$6) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 $6 = $6|0;
 var $$ = 0, $$0 = 0, $$0$copyload$i = 0, $$0104$lcssa = 0, $$0104131 = 0, $$0105$lcssa = 0, $$0105130 = 0, $$0109$lcssa = 0, $$0109129 = 0, $$1 = 0, $$1106 = 0, $$1108$lcssa = 0, $$1108126 = 0, $$1110 = 0, $$2 = 0, $$4$lcssa = 0, $$4127 = 0, $$sink153 = 0, $10 = 0, $11 = 0;
 var $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0;
 var $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $50 = 0, $51 = 0;
 var $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0;
 var $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0;
 var $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $or$cond = 0, $or$cond111 = 0, $storemerge = 0, $storemerge$in = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $7 = ($3>>>0)>(15);
 L1: do {
  if ($7) {
   $$0104131 = $0;$$0105130 = $1;$$0109129 = $3;
   while(1) {
    $8 = ($$0109129>>>0)<(271);
    $9 = $8 ? $$0109129 : 271;
    $10 = (($$0105130) + ($9)|0);
    $11 = ((($10)) + 10|0);
    $12 = ($11>>>0)<($2>>>0);
    if (!($12)) {
     $$0 = $2;
     break L1;
    }
    $13 = $9 << 8;
    $14 = (($13) + 61664)|0;
    $15 = $14&65535;
    HEAP8[$$0105130>>0]=$15&255;HEAP8[$$0105130+1>>0]=$15>>8;
    $16 = ((($$0105130)) + 2|0);
    $17 = (($$0109129) - ($9))|0;
    $18 = (_lzvn_copy64($16,$$0104131,$9)|0);
    $19 = (($$0104131) + ($9)|0);
    $20 = ($17>>>0)>(15);
    if ($20) {
     $$0104131 = $19;$$0105130 = $18;$$0109129 = $17;
    } else {
     $$0104$lcssa = $19;$$0105$lcssa = $18;$$0109$lcssa = $17;
     label = 5;
     break;
    }
   }
  } else {
   $$0104$lcssa = $0;$$0105$lcssa = $1;$$0109$lcssa = $3;
   label = 5;
  }
 } while(0);
 L6: do {
  if ((label|0) == 5) {
   $21 = ($$0109$lcssa>>>0)>(3);
   if ($21) {
    $22 = (($$0105$lcssa) + ($$0109$lcssa)|0);
    $23 = ((($22)) + 10|0);
    $24 = ($23>>>0)<($2>>>0);
    if (!($24)) {
     $$0 = $2;
     break;
    }
    $25 = (($$0109$lcssa) + 224)|0;
    $26 = $25&255;
    $27 = ((($$0105$lcssa)) + 1|0);
    HEAP8[$$0105$lcssa>>0] = $26;
    $28 = (_lzvn_copy64($27,$$0104$lcssa,$$0109$lcssa)|0);
    $29 = (($$0104$lcssa) + ($$0109$lcssa)|0);
    $$1 = $29;$$1106 = $28;$$1110 = 0;
   } else {
    $$1 = $$0104$lcssa;$$1106 = $$0105$lcssa;$$1110 = $$0109$lcssa;
   }
   $30 = $$1110 << 1;
   $31 = (10 - ($30))|0;
   $32 = ($31>>>0)<($4>>>0);
   $$ = $32 ? $31 : $4;
   $33 = (($4) - ($$))|0;
   $34 = (($$) + -3)|0;
   $$0$copyload$i = HEAPU8[$$1>>0]|(HEAPU8[$$1+1>>0]<<8)|(HEAPU8[$$1+2>>0]<<16)|(HEAPU8[$$1+3>>0]<<24);
   $35 = ((($$1106)) + 8|0);
   $36 = ($35>>>0)<($2>>>0);
   if ($36) {
    $37 = ($5|0)==($6|0);
    do {
     if ($37) {
      $38 = ($$1110|0)==(0);
      if ($38) {
       $39 = (($$) + 240)|0;
       $storemerge$in = $39;
      } else {
       $40 = $$1110 << 6;
       $41 = $34 << 3;
       $42 = (($41) + ($40))|0;
       $43 = $42 | 6;
       $storemerge$in = $43;
      }
      $$2 = ((($$1106)) + 1|0);
      $storemerge = $storemerge$in&255;
      HEAP8[$$1106>>0] = $storemerge;
      $$sink153 = $$2;
     } else {
      $44 = ($5>>>0)<(1536);
      if ($44) {
       $45 = $5 >>> 8;
       $46 = $$1110 << 6;
       $47 = (($46) + ($45))|0;
       $48 = $34 << 3;
       $49 = (($47) + ($48))|0;
       $50 = $49&255;
       $51 = ((($$1106)) + 1|0);
       HEAP8[$$1106>>0] = $50;
       $52 = $5&255;
       $53 = ((($$1106)) + 2|0);
       HEAP8[$51>>0] = $52;
       $$sink153 = $53;
       break;
      }
      $54 = ($5>>>0)>(16383);
      $55 = ($33|0)==(0);
      $or$cond = $54 | $55;
      $56 = ($4>>>0)>(34);
      $or$cond111 = $56 | $or$cond;
      if ($or$cond111) {
       $57 = $$1110 << 6;
       $58 = $34 << 3;
       $59 = (($58) + ($57))|0;
       $60 = $59 | 7;
       $61 = $60&255;
       $62 = ((($$1106)) + 1|0);
       HEAP8[$$1106>>0] = $61;
       $63 = $5&65535;
       HEAP8[$62>>0]=$63&255;HEAP8[$62+1>>0]=$63>>8;
       $64 = ((($$1106)) + 3|0);
       $$sink153 = $64;
       break;
      } else {
       $65 = (($4) + -3)|0;
       $66 = $65 >>> 2;
       $67 = (($66) + 160)|0;
       $68 = $$1110 << 3;
       $69 = (($67) + ($68))|0;
       $70 = $69&255;
       $71 = ((($$1106)) + 1|0);
       HEAP8[$$1106>>0] = $70;
       $72 = $5 << 2;
       $73 = $65 & 3;
       $74 = $72 | $73;
       $75 = $74&65535;
       HEAP8[$71>>0]=$75&255;HEAP8[$71+1>>0]=$75>>8;
       $76 = ((($$1106)) + 3|0);
       HEAP8[$76>>0]=$$0$copyload$i&255;HEAP8[$76+1>>0]=($$0$copyload$i>>8)&255;HEAP8[$76+2>>0]=($$0$copyload$i>>16)&255;HEAP8[$76+3>>0]=$$0$copyload$i>>24;
       $77 = (($76) + ($$1110)|0);
       $$0 = $77;
       break L6;
      }
     }
    } while(0);
    HEAP8[$$sink153>>0]=$$0$copyload$i&255;HEAP8[$$sink153+1>>0]=($$0$copyload$i>>8)&255;HEAP8[$$sink153+2>>0]=($$0$copyload$i>>16)&255;HEAP8[$$sink153+3>>0]=$$0$copyload$i>>24;
    $78 = (($$sink153) + ($$1110)|0);
    $79 = ($33>>>0)>(15);
    if ($79) {
     $$1108126 = $33;$$4127 = $78;
     while(1) {
      $80 = ((($$4127)) + 2|0);
      $81 = ($80>>>0)<($2>>>0);
      if (!($81)) {
       $$0 = $2;
       break L6;
      }
      $82 = ($$1108126>>>0)<(271);
      $83 = $82 ? $$1108126 : 271;
      $84 = $83 << 8;
      $85 = (($84) + 61680)|0;
      $86 = $85&65535;
      HEAP8[$$4127>>0]=$86&255;HEAP8[$$4127+1>>0]=$86>>8;
      $87 = (($$1108126) - ($83))|0;
      $88 = ($87>>>0)>(15);
      if ($88) {
       $$1108126 = $87;$$4127 = $80;
      } else {
       $$1108$lcssa = $87;$$4$lcssa = $80;
       break;
      }
     }
    } else {
     $$1108$lcssa = $33;$$4$lcssa = $78;
    }
    $89 = ($$1108$lcssa|0)==(0);
    if ($89) {
     $$0 = $$4$lcssa;
    } else {
     $90 = ((($$4$lcssa)) + 1|0);
     $91 = ($90>>>0)<($2>>>0);
     if ($91) {
      $92 = (($$1108$lcssa) + 240)|0;
      $93 = $92&255;
      HEAP8[$$4$lcssa>>0] = $93;
      $$0 = $90;
     } else {
      $$0 = $2;
     }
    }
   } else {
    $$0 = $2;
   }
  }
 } while(0);
 return ($$0|0);
}
function _lzvn_copy64($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$010 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ($2|0)==(0);
 if (!($3)) {
  $$010 = 0;
  while(1) {
   $5 = (($0) + ($$010)|0);
   $6 = (($1) + ($$010)|0);
   $7 = $6;
   $8 = $7;
   $9 = HEAPU8[$8>>0]|(HEAPU8[$8+1>>0]<<8)|(HEAPU8[$8+2>>0]<<16)|(HEAPU8[$8+3>>0]<<24);
   $10 = (($7) + 4)|0;
   $11 = $10;
   $12 = HEAPU8[$11>>0]|(HEAPU8[$11+1>>0]<<8)|(HEAPU8[$11+2>>0]<<16)|(HEAPU8[$11+3>>0]<<24);
   $13 = $5;
   $14 = $13;
   HEAP8[$14>>0]=$9&255;HEAP8[$14+1>>0]=($9>>8)&255;HEAP8[$14+2>>0]=($9>>16)&255;HEAP8[$14+3>>0]=$9>>24;
   $15 = (($13) + 4)|0;
   $16 = $15;
   HEAP8[$16>>0]=$12&255;HEAP8[$16+1>>0]=($12>>8)&255;HEAP8[$16+2>>0]=($12>>16)&255;HEAP8[$16+3>>0]=$12>>24;
   $17 = (($$010) + 8)|0;
   $18 = ($17>>>0)<($2>>>0);
   if ($18) {
    $$010 = $17;
   } else {
    break;
   }
  }
 }
 $4 = (($0) + ($2)|0);
 return ($4|0);
}
function _nmatch4($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$0$copyload$i = 0, $$0$copyload$i9 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = (($0) + ($1)|0);
 $$0$copyload$i = HEAPU8[$3>>0]|(HEAPU8[$3+1>>0]<<8)|(HEAPU8[$3+2>>0]<<16)|(HEAPU8[$3+3>>0]<<24);
 $4 = (($0) + ($2)|0);
 $$0$copyload$i9 = HEAPU8[$4>>0]|(HEAPU8[$4+1>>0]<<8)|(HEAPU8[$4+2>>0]<<16)|(HEAPU8[$4+3>>0]<<24);
 $5 = $$0$copyload$i9 ^ $$0$copyload$i;
 $6 = (_trailing_zero_bytes($5)|0);
 return ($6|0);
}
function _offset_to_s32($0) {
 $0 = $0|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return ($0|0);
}
function _lzfse_encode_buffer($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$014 = 0, $10 = 0, $11 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $5 = ($4|0)==(0|0);
 if ($5) {
  $7 = (_lzfse_encode_scratch_size()|0);
  $8 = (($7) + 1)|0;
  $9 = (_malloc($8)|0);
  $10 = ($9|0)==(0|0);
  if ($10) {
   $$014 = 0;
  } else {
   $11 = (_lzfse_encode_buffer_with_scratch($0,$1,$2,$3,$9)|0);
   _free($9);
   $$014 = $11;
  }
 } else {
  $6 = (_lzfse_encode_buffer_with_scratch($0,$1,$2,$3,$4)|0);
  $$014 = $6;
 }
 return ($$014|0);
}
function _lzfse_decode_scratch_size() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 return 47328;
}
function _lzfse_decode_buffer_with_scratch($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $5 = ((($4)) + 24|0);
 _memset(($5|0),0,47304)|0;
 HEAP32[$4>>2] = $2;
 $6 = ((($4)) + 4|0);
 HEAP32[$6>>2] = $2;
 $7 = (($2) + ($3)|0);
 $8 = ((($4)) + 8|0);
 HEAP32[$8>>2] = $7;
 $9 = ((($4)) + 12|0);
 HEAP32[$9>>2] = $0;
 $10 = ((($4)) + 16|0);
 HEAP32[$10>>2] = $0;
 $11 = (($0) + ($1)|0);
 $12 = ((($4)) + 20|0);
 HEAP32[$12>>2] = $11;
 $13 = (_lzfse_decode($4)|0);
 switch ($13|0) {
 case -2:  {
  $$0 = $1;
  break;
 }
 case 0:  {
  $14 = HEAP32[$9>>2]|0;
  $15 = $0;
  $16 = (($14) - ($15))|0;
  $$0 = $16;
  break;
 }
 default: {
  $$0 = 0;
 }
 }
 return ($$0|0);
}
function _lzfse_decode($0) {
 $0 = $0|0;
 var $$0$copyload$i = 0, $$0$copyload$i241 = 0, $$0$copyload$i243 = 0, $$0$copyload$i245 = 0, $$01011$i$i = 0, $$01011$i42$i = 0, $$01011$i46$i = 0, $$01011$i50$i = 0, $$012$i$i = 0, $$012$i41$i = 0, $$012$i45$i = 0, $$012$i49$i = 0, $$0232370 = 0, $$0301369 = 0, $$0302368 = 0, $$0303367 = 0, $$0304366 = 0, $$14$ph = 0, $$17 = 0, $$8$ph = 0;
 var $$cast = 0, $$cast372 = 0, $$in = 0, $$pre = 0, $$pre$phiZ2D = 0, $$pre384 = 0, $$pre386 = 0, $$pre387 = 0, $$pre388 = 0, $$pre389 = 0, $$sroa$0$0 = 0, $$sroa$0$0$$sroa_idx$i = 0, $$sroa$0$0$copyload$i = 0, $$sroa$0$0$in = 0, $$sroa$0253$0$$sroa$0253$0$$sroa_raw_idx$sroa_cast$hi = 0, $$sroa$0253$0$copyload = 0, $$sroa$0253$0$copyload$hi = 0, $$sroa$0253$0$copyload$hi$ext = 0, $$sroa$0253$0$copyload$hi$ext$sh = 0, $$sroa$0253$0$copyload$lo = 0;
 var $$sroa$0253$0$copyload$lo$ext = 0, $$sroa$0253$0$insert$ext261 = 0, $$sroa$0253$1 = 0, $$sroa$0274$0 = 0, $$sroa$0274$0$in = 0, $$sroa$0274$3365 = 0, $$sroa$0274$4$ph = 0, $$sroa$0274$5$ph = 0, $$sroa$0278$0$$sroa$0278$0$$sroa_raw_idx$sroa_cast$hi = 0, $$sroa$0278$0$copyload = 0, $$sroa$0278$0$copyload$hi = 0, $$sroa$0278$0$copyload$hi$ext = 0, $$sroa$0278$0$copyload$hi$ext$sh = 0, $$sroa$0278$0$copyload$lo = 0, $$sroa$0278$0$copyload$lo$ext = 0, $$sroa$0278$0$insert$ext = 0, $$sroa$0278$1 = 0, $$sroa$0278$4363 = 0, $$sroa$0278$5$ph = 0, $$sroa$0278$6$ph = 0;
 var $$sroa$18$1 = 0, $$sroa$18$4364 = 0, $$sroa$18$5$ph = 0, $$sroa$18$6$ph = 0, $$sroa$4$0$$sroa_idx6$i = 0, $$sroa$4$0$copyload$i = 0, $$sroa$5$0$$sroa_idx8$i = 0, $$sroa$5$0$copyload$i = 0, $$sroa$6$0$$sroa_idx10$i = 0, $$sroa$6$0$copyload$i = 0, $$sroa$7$1 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0;
 var $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0;
 var $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0;
 var $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0;
 var $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0;
 var $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0, $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0;
 var $198 = 0, $199 = 0, $2 = 0, $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0, $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0;
 var $215 = 0, $216 = 0, $217 = 0, $218 = 0, $219 = 0, $22 = 0, $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0, $226 = 0, $227 = 0, $228 = 0, $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0;
 var $233 = 0, $234 = 0, $235 = 0, $236 = 0, $237 = 0, $238 = 0, $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0, $244 = 0, $245 = 0, $246 = 0, $247 = 0, $248 = 0, $249 = 0, $25 = 0, $250 = 0;
 var $251 = 0, $252 = 0, $253 = 0, $254 = 0, $255 = 0, $256 = 0, $257 = 0, $258 = 0, $259 = 0, $26 = 0, $260 = 0, $261 = 0, $262 = 0, $263 = 0, $264 = 0, $265 = 0, $266 = 0, $267 = 0, $268 = 0, $269 = 0;
 var $27 = 0, $270 = 0, $271 = 0, $272 = 0, $273 = 0, $274 = 0, $275 = 0, $276 = 0, $277 = 0, $278 = 0, $279 = 0, $28 = 0, $280 = 0, $281 = 0, $282 = 0, $283 = 0, $284 = 0, $285 = 0, $286 = 0, $287 = 0;
 var $288 = 0, $289 = 0, $29 = 0, $290 = 0, $291 = 0, $292 = 0, $293 = 0, $294 = 0, $295 = 0, $296 = 0, $297 = 0, $298 = 0, $299 = 0, $3 = 0, $30 = 0, $300 = 0, $301 = 0, $302 = 0, $303 = 0, $304 = 0;
 var $305 = 0, $306 = 0, $307 = 0, $308 = 0, $309 = 0, $31 = 0, $310 = 0, $311 = 0, $312 = 0, $313 = 0, $314 = 0, $315 = 0, $316 = 0, $317 = 0, $318 = 0, $319 = 0, $32 = 0, $320 = 0, $321 = 0, $322 = 0;
 var $323 = 0, $324 = 0, $325 = 0, $326 = 0, $327 = 0, $328 = 0, $329 = 0, $33 = 0, $330 = 0, $331 = 0, $332 = 0, $333 = 0, $334 = 0, $335 = 0, $336 = 0, $337 = 0, $338 = 0, $339 = 0, $34 = 0, $340 = 0;
 var $341 = 0, $342 = 0, $343 = 0, $344 = 0, $345 = 0, $346 = 0, $347 = 0, $348 = 0, $349 = 0, $35 = 0, $350 = 0, $351 = 0, $352 = 0, $353 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0;
 var $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0;
 var $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0;
 var $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0;
 var $96 = 0, $97 = 0, $98 = 0, $99 = 0, $exitcond$i$i = 0, $exitcond$i43$i = 0, $exitcond$i47$i = 0, $exitcond$i51$i = 0, $or$cond = 0, $or$cond238 = 0, $spec$select = 0, $spec$select235 = 0, $spec$select239 = 0, $storemerge = 0, $switch$split112D = 0, $switch$split142D = 0, $switch$split172D = 0, $switch$split202D = 0, $switch$split22D = 0, $switch$split2D = 0;
 var $switch$split52D = 0, $switch$split82D = 0, dest = 0, label = 0, sp = 0, stop = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 816|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(816|0);
 $1 = sp + 44|0;
 $2 = sp;
 $3 = ((($0)) + 28|0);
 $4 = ((($0)) + 8|0);
 $5 = ((($0)) + 47324|0);
 $6 = ((($0)) + 47316|0);
 $7 = ((($0)) + 36|0);
 $8 = ((($2)) + 4|0);
 $9 = ((($0)) + 20|0);
 $10 = ((($0)) + 12|0);
 $11 = ((($0)) + 16|0);
 $12 = ((($2)) + 12|0);
 $13 = ((($2)) + 8|0);
 $14 = ((($2)) + 16|0);
 $15 = ((($0)) + 47312|0);
 $16 = ((($0)) + 47320|0);
 $17 = ((($1)) + 20|0);
 $18 = ((($1)) + 24|0);
 $19 = ((($2)) + 36|0);
 $20 = ((($2)) + 40|0);
 $21 = ((($1)) + 12|0);
 $22 = ((($1)) + 16|0);
 $$sroa$0$0$$sroa_idx$i = ((($1)) + 32|0);
 $$sroa$4$0$$sroa_idx6$i = ((($1)) + 34|0);
 $$sroa$5$0$$sroa_idx8$i = ((($1)) + 36|0);
 $$sroa$6$0$$sroa_idx10$i = ((($1)) + 38|0);
 $23 = ((($1)) + 44|0);
 $24 = ((($1)) + 46|0);
 $25 = ((($1)) + 48|0);
 $26 = ((($0)) + 32|0);
 $27 = ((($1)) + 258|0);
 $28 = ((($0)) + 3152|0);
 $29 = ((($1)) + 50|0);
 $30 = ((($0)) + 80|0);
 $31 = ((($1)) + 90|0);
 $32 = ((($0)) + 592|0);
 $33 = ((($1)) + 130|0);
 $34 = ((($0)) + 1104|0);
 $35 = ((($0)) + 4|0);
 $36 = ((($1)) + 28|0);
 $37 = ((($0)) + 7248|0);
 $38 = ((($0)) + 40|0);
 $39 = ((($1)) + 40|0);
 $40 = ((($0)) + 68|0);
 $41 = ((($0)) + 70|0);
 $42 = ((($0)) + 72|0);
 $43 = ((($0)) + 64|0);
 $44 = ((($0)) + 48|0);
 $45 = ((($0)) + 44|0);
 $46 = ((($0)) + 52|0);
 $47 = ((($0)) + 56|0);
 $48 = ((($2)) + 4|0);
 L1: while(1) {
  $49 = HEAP32[$3>>2]|0;
  $switch$split2D = ($49|0)<(829978210);
  L3: do {
   if ($switch$split2D) {
    $switch$split52D = ($49|0)<(762869346);
    if (!($switch$split52D)) {
     switch ($49|0) {
     case 762869346:  {
      break;
     }
     default: {
      $$17 = -3;
      break L1;
     }
     }
     $280 = HEAP32[$5>>2]|0;
     $281 = ($280|0)==(0);
     if ($281) {
      HEAP32[$3>>2] = 0;
      break;
     }
     $282 = HEAP32[$4>>2]|0;
     $283 = HEAP32[$0>>2]|0;
     $284 = ($282>>>0)>($283>>>0);
     if (!($284)) {
      $$17 = -1;
      break L1;
     }
     $285 = $282;
     $286 = $283;
     $287 = (($285) - ($286))|0;
     $288 = ($280>>>0)>($287>>>0);
     $spec$select = $288 ? $287 : $280;
     $289 = HEAP32[$9>>2]|0;
     $290 = HEAP32[$10>>2]|0;
     $291 = ($289>>>0)>($290>>>0);
     if (!($291)) {
      $$17 = -2;
      break L1;
     }
     $292 = $289;
     $293 = $290;
     $294 = (($292) - ($293))|0;
     $295 = ($spec$select>>>0)>($294>>>0);
     $spec$select235 = $295 ? $294 : $spec$select;
     _memcpy(($290|0),($283|0),($spec$select235|0))|0;
     $296 = HEAP32[$0>>2]|0;
     $297 = (($296) + ($spec$select235)|0);
     HEAP32[$0>>2] = $297;
     $298 = HEAP32[$10>>2]|0;
     $299 = (($298) + ($spec$select235)|0);
     HEAP32[$10>>2] = $299;
     $300 = HEAP32[$5>>2]|0;
     $301 = (($300) - ($spec$select235))|0;
     HEAP32[$5>>2] = $301;
     break;
    }
    switch ($49|0) {
    case 0:  {
     break;
    }
    default: {
     $$17 = -3;
     break L1;
    }
    }
    $50 = HEAP32[$0>>2]|0;
    $51 = ((($50)) + 4|0);
    $52 = HEAP32[$4>>2]|0;
    $53 = ($51>>>0)>($52>>>0);
    if ($53) {
     $$17 = -1;
     break L1;
    }
    $$0$copyload$i = HEAPU8[$50>>0]|(HEAPU8[$50+1>>0]<<8)|(HEAPU8[$50+2>>0]<<16)|(HEAPU8[$50+3>>0]<<24);
    $switch$split22D = ($$0$copyload$i|0)<(829978210);
    if ($switch$split22D) {
     $switch$split112D = ($$0$copyload$i|0)<(762869346);
     if ($switch$split112D) {
      label = 82;
      break L1;
     }
     switch ($$0$copyload$i|0) {
     case 762869346:  {
      break;
     }
     default: {
      $$17 = -3;
      break L1;
     }
     }
     $55 = ((($50)) + 8|0);
     $56 = ($55>>>0)>($52>>>0);
     if ($56) {
      $$17 = -1;
      break L1;
     }
     $$0$copyload$i241 = HEAPU8[$51>>0]|(HEAPU8[$51+1>>0]<<8)|(HEAPU8[$51+2>>0]<<16)|(HEAPU8[$51+3>>0]<<24);
     HEAP32[$5>>2] = $$0$copyload$i241;
     HEAP32[$0>>2] = $55;
     HEAP32[$3>>2] = 762869346;
     break;
    }
    $switch$split142D = ($$0$copyload$i|0)<(846755426);
    L22: do {
     if ($switch$split142D) {
      switch ($$0$copyload$i|0) {
      case 829978210:  {
       break;
      }
      default: {
       $$17 = -3;
       break L1;
      }
      }
     } else {
      $switch$split202D = ($$0$copyload$i|0)<(1853388386);
      if ($switch$split202D) {
       switch ($$0$copyload$i|0) {
       case 846755426:  {
        break L22;
        break;
       }
       default: {
        $$17 = -3;
        break L1;
       }
       }
      }
      switch ($$0$copyload$i|0) {
      case 1853388386:  {
       break;
      }
      default: {
       $$17 = -3;
       break L1;
      }
      }
      $57 = ((($50)) + 12|0);
      $58 = ($57>>>0)>($52>>>0);
      if ($58) {
       $$17 = -1;
       break L1;
      }
      $$0$copyload$i243 = HEAPU8[$51>>0]|(HEAPU8[$51+1>>0]<<8)|(HEAPU8[$51+2>>0]<<16)|(HEAPU8[$51+3>>0]<<24);
      HEAP32[$15>>2] = $$0$copyload$i243;
      $59 = ((($50)) + 8|0);
      $$0$copyload$i245 = HEAPU8[$59>>0]|(HEAPU8[$59+1>>0]<<8)|(HEAPU8[$59+2>>0]<<16)|(HEAPU8[$59+3>>0]<<24);
      HEAP32[$6>>2] = $$0$copyload$i245;
      HEAP32[$16>>2] = 0;
      HEAP32[$0>>2] = $57;
      HEAP32[$3>>2] = 1853388386;
      break L3;
     }
    } while(0);
    $60 = ($$0$copyload$i|0)==(846755426);
    if ($60) {
     $61 = ((($50)) + 32|0);
     $62 = ($61>>>0)>($52>>>0);
     if ($62) {
      $$8$ph = -1;
      label = 49;
      break L1;
     }
     $63 = (_lzfse_decode_v2_header_size($50)|0);
     $64 = (($50) + ($63)|0);
     $65 = ($64>>>0)>($52>>>0);
     if ($65) {
      $$8$ph = -1;
      label = 49;
      break L1;
     }
     $66 = (_lzfse_decode_v1($1,$50)|0);
     $67 = ($66|0)==(0);
     if (!($67)) {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
     $$pre386 = HEAP32[$0>>2]|0;
     $$pre387 = HEAP32[$4>>2]|0;
     $$pre389 = (($$pre386) + ($63)|0);
     $$pre$phiZ2D = $$pre389;$75 = $$pre387;
    } else {
     $68 = ((($50)) + 772|0);
     $69 = ($68>>>0)>($52>>>0);
     if ($69) {
      $$8$ph = -1;
      label = 49;
      break L1;
     }
     _memcpy(($1|0),($50|0),772)|0;
     $$pre$phiZ2D = $68;$75 = $52;
    }
    $70 = HEAP32[$17>>2]|0;
    $71 = (($$pre$phiZ2D) + ($70)|0);
    $72 = HEAP32[$18>>2]|0;
    $73 = (($71) + ($72)|0);
    $74 = ($73>>>0)>($75>>>0);
    if ($74) {
     $$8$ph = -1;
     label = 49;
     break L1;
    }
    $76 = HEAP32[$1>>2]|0;
    $77 = HEAP32[$21>>2]|0;
    $78 = ($77>>>0)<(40001);
    $79 = HEAP32[$22>>2]|0;
    $80 = ($79>>>0)<(10001);
    $$sroa$0$0$copyload$i = HEAP16[$$sroa$0$0$$sroa_idx$i>>1]|0;
    $$sroa$4$0$copyload$i = HEAP16[$$sroa$4$0$$sroa_idx6$i>>1]|0;
    $$sroa$5$0$copyload$i = HEAP16[$$sroa$5$0$$sroa_idx8$i>>1]|0;
    $$sroa$6$0$copyload$i = HEAP16[$$sroa$6$0$$sroa_idx10$i>>1]|0;
    $81 = ($$sroa$0$0$copyload$i&65535)<(1024);
    $82 = ($$sroa$4$0$copyload$i&65535)<(1024);
    $83 = ($$sroa$5$0$copyload$i&65535)<(1024);
    $84 = ($$sroa$6$0$copyload$i&65535)<(1024);
    $85 = HEAP16[$23>>1]|0;
    $86 = ($85&65535)<(64);
    $87 = HEAP16[$24>>1]|0;
    $88 = ($87&65535)<(64);
    $89 = HEAP16[$25>>1]|0;
    $90 = ($89&65535)<(256);
    $$01011$i$i = 0;$$012$i$i = 0;
    while(1) {
     $91 = (((($1)) + 50|0) + ($$012$i$i<<1)|0);
     $92 = HEAP16[$91>>1]|0;
     $93 = $92&65535;
     $94 = (($$01011$i$i) + ($93))|0;
     $95 = (($$012$i$i) + 1)|0;
     $exitcond$i$i = ($95|0)==(20);
     if ($exitcond$i$i) {
      break;
     } else {
      $$01011$i$i = $94;$$012$i$i = $95;
     }
    }
    $96 = ($76|0)!=(829978210);
    $97 = $78 ? 0 : 2;
    $98 = $80 ? 0 : 4;
    $99 = $81 ? 0 : 8;
    $100 = $82 ? 0 : 16;
    $101 = $83 ? 0 : 32;
    $102 = $84 ? 0 : 64;
    $103 = $86 ? 0 : 128;
    $104 = $88 ? 0 : 256;
    $105 = $96&1;
    $106 = $97 | $105;
    $107 = $106 | $98;
    $108 = $107 | $99;
    $109 = $108 | $100;
    $110 = $109 | $101;
    $111 = $110 | $102;
    $112 = $111 | $103;
    $113 = $112 | $104;
    $114 = ($94>>>0)<(65);
    $$01011$i50$i = 0;$$012$i49$i = 0;
    while(1) {
     $115 = (((($1)) + 90|0) + ($$012$i49$i<<1)|0);
     $116 = HEAP16[$115>>1]|0;
     $117 = $116&65535;
     $118 = (($$01011$i50$i) + ($117))|0;
     $119 = (($$012$i49$i) + 1)|0;
     $exitcond$i51$i = ($119|0)==(20);
     if ($exitcond$i51$i) {
      break;
     } else {
      $$01011$i50$i = $118;$$012$i49$i = $119;
     }
    }
    $120 = $90 ? 0 : 512;
    $121 = $114 ? 0 : 1024;
    $122 = ($118>>>0)<(65);
    $$01011$i46$i = 0;$$012$i45$i = 0;
    while(1) {
     $123 = (((($1)) + 130|0) + ($$012$i45$i<<1)|0);
     $124 = HEAP16[$123>>1]|0;
     $125 = $124&65535;
     $126 = (($$01011$i46$i) + ($125))|0;
     $127 = (($$012$i45$i) + 1)|0;
     $exitcond$i47$i = ($127|0)==(64);
     if ($exitcond$i47$i) {
      break;
     } else {
      $$01011$i46$i = $126;$$012$i45$i = $127;
     }
    }
    $128 = $113 | $120;
    $129 = $122 ? 0 : 2048;
    $130 = ($126>>>0)<(257);
    $$01011$i42$i = 0;$$012$i41$i = 0;
    while(1) {
     $131 = (((($1)) + 258|0) + ($$012$i41$i<<1)|0);
     $132 = HEAP16[$131>>1]|0;
     $133 = $132&65535;
     $134 = (($$01011$i42$i) + ($133))|0;
     $135 = (($$012$i41$i) + 1)|0;
     $exitcond$i43$i = ($135|0)==(256);
     if ($exitcond$i43$i) {
      break;
     } else {
      $$01011$i42$i = $134;$$012$i41$i = $135;
     }
    }
    $136 = $128 | $121;
    $137 = $136 | $129;
    $138 = $130 ? 0 : 4096;
    $139 = $137 | $138;
    $140 = ($134>>>0)<(1025);
    $141 = $140 ? 0 : 8192;
    $142 = $139 | $141;
    $143 = ($142|0)==(0);
    if (!($143)) {
     $$8$ph = -3;
     label = 49;
     break L1;
    }
    HEAP32[$0>>2] = $$pre$phiZ2D;
    HEAP32[$7>>2] = $72;
    HEAP32[$26>>2] = $79;
    (_fse_init_decoder_table(1024,256,$27,$28)|0);
    _fse_init_value_decoder_table(64,20,$29,448,480,$30);
    _fse_init_value_decoder_table(64,20,$31,336,368,$32);
    _fse_init_value_decoder_table(256,64,$33,16,80,$34);
    $144 = HEAP32[$35>>2]|0;
    $145 = HEAP32[$17>>2]|0;
    $146 = HEAP32[$0>>2]|0;
    $147 = (($146) + ($145)|0);
    HEAP32[$0>>2] = $147;
    $148 = HEAP32[$36>>2]|0;
    $149 = ($148|0)==(0);
    if ($149) {
     $152 = ((($144)) + 3|0);
     $153 = ($147>>>0)<($152>>>0);
     if ($153) {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
     $154 = ((($147)) + -3|0);
     $$sroa$0278$0$copyload$lo = HEAPU8[$154>>0]|(HEAPU8[$154+1>>0]<<8);
     $$sroa$0278$0$copyload$lo$ext = $$sroa$0278$0$copyload$lo&65535;
     $$sroa$0278$0$$sroa$0278$0$$sroa_raw_idx$sroa_cast$hi = ((($154)) + 2|0);
     $$sroa$0278$0$copyload$hi = HEAP8[$$sroa$0278$0$$sroa$0278$0$$sroa_raw_idx$sroa_cast$hi>>0]|0;
     $$sroa$0278$0$copyload$hi$ext = $$sroa$0278$0$copyload$hi&255;
     $$sroa$0278$0$copyload$hi$ext$sh = $$sroa$0278$0$copyload$hi$ext << 16;
     $$sroa$0278$0$copyload = $$sroa$0278$0$copyload$lo$ext | $$sroa$0278$0$copyload$hi$ext$sh;
     $$sroa$0278$0$insert$ext = $$sroa$0278$0$copyload & 16777215;
     $$sroa$0274$0$in = $154;$$sroa$0278$1 = $$sroa$0278$0$insert$ext;$$sroa$18$1 = 24;
    } else {
     $150 = ((($144)) + 4|0);
     $151 = ($147>>>0)<($150>>>0);
     if ($151) {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
     $155 = ((($147)) + -4|0);
     $156 = HEAPU8[$155>>0]|(HEAPU8[$155+1>>0]<<8)|(HEAPU8[$155+2>>0]<<16)|(HEAPU8[$155+3>>0]<<24);
     $157 = (($148) + 32)|0;
     $158 = $157 & -8;
     $159 = ($158|0)==(24);
     if ($159) {
      $$sroa$0274$0$in = $155;$$sroa$0278$1 = $156;$$sroa$18$1 = $157;
     } else {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
    }
    $160 = $$sroa$0278$1 >>> $$sroa$18$1;
    $161 = ($160|0)==(0);
    if (!($161)) {
     $$8$ph = -3;
     label = 49;
     break L1;
    }
    $162 = HEAP32[$21>>2]|0;
    $163 = ($162|0)==(0);
    if ($163) {
     $$in = $147;
    } else {
     $164 = HEAP16[$$sroa$6$0$$sroa_idx10$i>>1]|0;
     $165 = HEAP16[$$sroa$5$0$$sroa_idx8$i>>1]|0;
     $166 = HEAP16[$$sroa$4$0$$sroa_idx6$i>>1]|0;
     $167 = HEAP16[$$sroa$0$0$$sroa_idx$i>>1]|0;
     $$sroa$0274$0 = $$sroa$0274$0$in;
     $$0232370 = 0;$$0301369 = $164;$$0302368 = $165;$$0303367 = $166;$$0304366 = $167;$$sroa$0274$3365 = $$sroa$0274$0;$$sroa$0278$4363 = $$sroa$0278$1;$$sroa$18$4364 = $$sroa$18$1;
     while(1) {
      $168 = (31 - ($$sroa$18$4364))|0;
      $169 = $168 & -8;
      $170 = ($169|0)>(0);
      if ($170) {
       $171 = $$sroa$0274$3365;
       $172 = $168 >> 3;
       $173 = (0 - ($172))|0;
       $174 = (($171) + ($173)|0);
       $175 = ($174>>>0)<($144>>>0);
       if ($175) {
        $$8$ph = -3;
        label = 49;
        break L1;
       }
       $176 = (($169) + ($$sroa$18$4364))|0;
       $177 = $$sroa$0278$4363 << $169;
       $178 = $174;
       $179 = HEAP32[$174>>2]|0;
       $180 = (_fse_mask_lsb32_17($179,$169)|0);
       $181 = $180 | $177;
       $$sroa$0274$4$ph = $178;$$sroa$0278$5$ph = $181;$$sroa$18$5$ph = $176;
      } else {
       $$sroa$0274$4$ph = $$sroa$0274$3365;$$sroa$0278$5$ph = $$sroa$0278$4363;$$sroa$18$5$ph = $$sroa$18$4364;
      }
      $182 = $$0304366&65535;
      $183 = (((($0)) + 3152|0) + ($182<<2)|0);
      $184 = HEAP32[$183>>2]|0;
      $185 = $184 >>> 16;
      $186 = $184 & 255;
      $187 = (($$sroa$18$5$ph) - ($186))|0;
      $188 = $$sroa$0278$5$ph >>> $187;
      $189 = (_fse_mask_lsb32_17($$sroa$0278$5$ph,$187)|0);
      $190 = (($188) + ($185))|0;
      $191 = $190&65535;
      $192 = $184 >>> 8;
      $193 = (_fse_mask_lsb32_17($192,8)|0);
      $194 = $193&255;
      $195 = (((($0)) + 7248|0) + ($$0232370)|0);
      HEAP8[$195>>0] = $194;
      $196 = $$0303367&65535;
      $197 = (((($0)) + 3152|0) + ($196<<2)|0);
      $198 = HEAP32[$197>>2]|0;
      $199 = $198 >>> 16;
      $200 = $198 & 255;
      $201 = (($187) - ($200))|0;
      $202 = $189 >>> $201;
      $203 = (_fse_mask_lsb32_17($189,$201)|0);
      $204 = (($202) + ($199))|0;
      $205 = $204&65535;
      $206 = $198 >>> 8;
      $207 = (_fse_mask_lsb32_17($206,8)|0);
      $208 = $207&255;
      $209 = $$0232370 | 1;
      $210 = (((($0)) + 7248|0) + ($209)|0);
      HEAP8[$210>>0] = $208;
      $211 = (31 - ($201))|0;
      $212 = $211 & -8;
      $213 = ($212|0)>(0);
      if ($213) {
       $214 = $$sroa$0274$4$ph;
       $215 = $211 >> 3;
       $216 = (0 - ($215))|0;
       $217 = (($214) + ($216)|0);
       $218 = ($217>>>0)<($144>>>0);
       if ($218) {
        $$8$ph = -3;
        label = 49;
        break L1;
       }
       $219 = (($212) + ($201))|0;
       $220 = $203 << $212;
       $221 = $217;
       $222 = HEAP32[$217>>2]|0;
       $223 = (_fse_mask_lsb32_17($222,$212)|0);
       $224 = $223 | $220;
       $$sroa$0274$5$ph = $221;$$sroa$0278$6$ph = $224;$$sroa$18$6$ph = $219;
      } else {
       $$sroa$0274$5$ph = $$sroa$0274$4$ph;$$sroa$0278$6$ph = $203;$$sroa$18$6$ph = $201;
      }
      $225 = $$0302368&65535;
      $226 = (((($0)) + 3152|0) + ($225<<2)|0);
      $227 = HEAP32[$226>>2]|0;
      $228 = $227 >>> 16;
      $229 = $227 & 255;
      $230 = (($$sroa$18$6$ph) - ($229))|0;
      $231 = $$sroa$0278$6$ph >>> $230;
      $232 = (_fse_mask_lsb32_17($$sroa$0278$6$ph,$230)|0);
      $233 = (($231) + ($228))|0;
      $234 = $233&65535;
      $235 = $227 >>> 8;
      $236 = (_fse_mask_lsb32_17($235,8)|0);
      $237 = $236&255;
      $238 = $$0232370 | 2;
      $239 = (((($0)) + 7248|0) + ($238)|0);
      HEAP8[$239>>0] = $237;
      $240 = $$0301369&65535;
      $241 = (((($0)) + 3152|0) + ($240<<2)|0);
      $242 = HEAP32[$241>>2]|0;
      $243 = $242 >>> 16;
      $244 = $242 & 255;
      $245 = (($230) - ($244))|0;
      $246 = $232 >>> $245;
      $247 = (_fse_mask_lsb32_17($232,$245)|0);
      $248 = (($246) + ($243))|0;
      $249 = $248&65535;
      $250 = $242 >>> 8;
      $251 = (_fse_mask_lsb32_17($250,8)|0);
      $252 = $251&255;
      $253 = $$0232370 | 3;
      $254 = (((($0)) + 7248|0) + ($253)|0);
      HEAP8[$254>>0] = $252;
      $255 = (($$0232370) + 4)|0;
      $256 = ($255>>>0)<($162>>>0);
      if ($256) {
       $$0232370 = $255;$$0301369 = $249;$$0302368 = $234;$$0303367 = $205;$$0304366 = $191;$$sroa$0274$3365 = $$sroa$0274$5$ph;$$sroa$0278$4363 = $247;$$sroa$18$4364 = $245;
      } else {
       break;
      }
     }
     $$pre388 = HEAP32[$0>>2]|0;
     $$in = $$pre388;
    }
    $257 = $$in;
    HEAP32[$38>>2] = $37;
    $258 = HEAP32[$18>>2]|0;
    $259 = (($$in) + ($258)|0);
    $260 = HEAP32[$39>>2]|0;
    $261 = ($260|0)==(0);
    if ($261) {
     $263 = ($258|0)<(3);
     if ($263) {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
     $264 = ((($259)) + -3|0);
     $$sroa$0253$0$copyload$lo = HEAPU8[$264>>0]|(HEAPU8[$264+1>>0]<<8);
     $$sroa$0253$0$copyload$lo$ext = $$sroa$0253$0$copyload$lo&65535;
     $$sroa$0253$0$$sroa$0253$0$$sroa_raw_idx$sroa_cast$hi = ((($264)) + 2|0);
     $$sroa$0253$0$copyload$hi = HEAP8[$$sroa$0253$0$$sroa$0253$0$$sroa_raw_idx$sroa_cast$hi>>0]|0;
     $$sroa$0253$0$copyload$hi$ext = $$sroa$0253$0$copyload$hi&255;
     $$sroa$0253$0$copyload$hi$ext$sh = $$sroa$0253$0$copyload$hi$ext << 16;
     $$sroa$0253$0$copyload = $$sroa$0253$0$copyload$lo$ext | $$sroa$0253$0$copyload$hi$ext$sh;
     $$sroa$0253$0$insert$ext261 = $$sroa$0253$0$copyload & 16777215;
     $$sroa$0$0$in = $264;$$sroa$0253$1 = $$sroa$0253$0$insert$ext261;$$sroa$7$1 = 24;
    } else {
     $262 = ($258|0)<(4);
     if ($262) {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
     $265 = ((($259)) + -4|0);
     $266 = HEAPU8[$265>>0]|(HEAPU8[$265+1>>0]<<8)|(HEAPU8[$265+2>>0]<<16)|(HEAPU8[$265+3>>0]<<24);
     $267 = (($260) + 32)|0;
     $268 = $267 & -8;
     $269 = ($268|0)==(24);
     if ($269) {
      $$sroa$0$0$in = $265;$$sroa$0253$1 = $266;$$sroa$7$1 = $267;
     } else {
      $$8$ph = -3;
      label = 49;
      break L1;
     }
    }
    $270 = $$sroa$0253$1 >>> $$sroa$7$1;
    $271 = ($270|0)==(0);
    if (!($271)) {
     $$8$ph = -3;
     label = 49;
     break L1;
    }
    $$sroa$0$0 = $$sroa$0$0$in;
    $272 = HEAP16[$23>>1]|0;
    HEAP16[$40>>1] = $272;
    $273 = HEAP16[$24>>1]|0;
    HEAP16[$41>>1] = $273;
    $274 = HEAP16[$25>>1]|0;
    HEAP16[$42>>1] = $274;
    $275 = (($$sroa$0$0) - ($257))|0;
    HEAP32[$43>>2] = $275;
    HEAP32[$44>>2] = 0;
    HEAP32[$45>>2] = 0;
    HEAP32[$46>>2] = -1;
    $276 = $47;
    $277 = $276;
    HEAP32[$277>>2] = $$sroa$0253$1;
    $278 = (($276) + 4)|0;
    $279 = $278;
    HEAP32[$279>>2] = $$sroa$7$1;
    HEAP32[$3>>2] = $$0$copyload$i;
   } else {
    $switch$split82D = ($49|0)<(846755426);
    L82: do {
     if ($switch$split82D) {
      switch ($49|0) {
      case 829978210:  {
       break;
      }
      default: {
       $$17 = -3;
       break L1;
      }
      }
     } else {
      $switch$split172D = ($49|0)<(1853388386);
      if ($switch$split172D) {
       switch ($49|0) {
       case 846755426:  {
        break L82;
        break;
       }
       default: {
        $$17 = -3;
        break L1;
       }
       }
      }
      switch ($49|0) {
      case 1853388386:  {
       break;
      }
      default: {
       $$17 = -3;
       break L1;
      }
      }
      $315 = HEAP32[$6>>2]|0;
      $316 = ($315|0)==(0);
      if ($316) {
       $$pre = HEAP32[$0>>2]|0;
       $$pre384 = HEAP32[$4>>2]|0;
       $321 = $$pre;$323 = $$pre384;
      } else {
       $317 = HEAP32[$4>>2]|0;
       $318 = HEAP32[$0>>2]|0;
       $319 = ($317>>>0)>($318>>>0);
       $320 = $318;
       if ($319) {
        $321 = $320;$323 = $317;
       } else {
        $$17 = -1;
        break L1;
       }
      }
      dest=$48; stop=dest+40|0; do { HEAP32[dest>>2]=0|0; dest=dest+4|0; } while ((dest|0) < (stop|0));
      HEAP32[$2>>2] = $321;
      $322 = $323;
      $324 = (($322) - ($321))|0;
      $325 = ($324>>>0)>($315>>>0);
      $$cast = $321;
      $326 = (($$cast) + ($315)|0);
      $storemerge = $325 ? $326 : $323;
      HEAP32[$8>>2] = $storemerge;
      $327 = HEAP32[$11>>2]|0;
      HEAP32[$12>>2] = $327;
      $328 = HEAP32[$10>>2]|0;
      HEAP32[$13>>2] = $328;
      $329 = HEAP32[$9>>2]|0;
      HEAP32[$14>>2] = $329;
      $330 = $329;
      $331 = (($330) - ($328))|0;
      $332 = HEAP32[$15>>2]|0;
      $333 = ($331>>>0)>($332>>>0);
      if ($333) {
       $$cast372 = $328;
       $334 = (($$cast372) + ($332)|0);
       HEAP32[$14>>2] = $334;
      }
      $335 = HEAP32[$16>>2]|0;
      HEAP32[$19>>2] = $335;
      HEAP32[$20>>2] = 0;
      _lzvn_decode($2);
      $336 = HEAP32[$2>>2]|0;
      $337 = HEAP32[$0>>2]|0;
      $338 = $336;
      $339 = (($338) - ($337))|0;
      $340 = HEAP32[$13>>2]|0;
      $341 = HEAP32[$10>>2]|0;
      $342 = (($340) - ($341))|0;
      $343 = HEAP32[$6>>2]|0;
      $344 = ($343>>>0)<($339>>>0);
      if ($344) {
       $$14$ph = -3;
       label = 71;
       break L1;
      }
      $345 = HEAP32[$15>>2]|0;
      $346 = ($345>>>0)<($342>>>0);
      if ($346) {
       $$14$ph = -3;
       label = 71;
       break L1;
      }
      HEAP32[$0>>2] = $336;
      HEAP32[$10>>2] = $340;
      $347 = (($343) - ($339))|0;
      HEAP32[$6>>2] = $347;
      $348 = (($345) - ($342))|0;
      HEAP32[$15>>2] = $348;
      $349 = HEAP32[$19>>2]|0;
      HEAP32[$16>>2] = $349;
      $350 = ($347|0)==(0);
      $351 = ($348|0)!=(0);
      $352 = HEAP32[$20>>2]|0;
      $353 = ($352|0)==(0);
      if (!($350)) {
       label = 70;
       break L1;
      }
      $or$cond = $351 | $353;
      if ($or$cond) {
       $$14$ph = -3;
       label = 71;
       break L1;
      }
      HEAP32[$3>>2] = 0;
      break L3;
     }
    } while(0);
    $302 = HEAP32[$4>>2]|0;
    $303 = HEAP32[$0>>2]|0;
    $304 = ($302>>>0)>($303>>>0);
    if (!($304)) {
     $$17 = -1;
     break L1;
    }
    $305 = HEAP32[$7>>2]|0;
    $306 = $302;
    $307 = $303;
    $308 = (($306) - ($307))|0;
    $309 = ($305>>>0)>($308>>>0);
    if ($309) {
     $$17 = -1;
     break L1;
    }
    $310 = (_lzfse_decode_lmd($0)|0);
    $311 = ($310|0)==(0);
    if (!($311)) {
     $$17 = $310;
     break L1;
    }
    HEAP32[$3>>2] = 0;
    $312 = HEAP32[$7>>2]|0;
    $313 = HEAP32[$0>>2]|0;
    $314 = (($313) + ($312)|0);
    HEAP32[$0>>2] = $314;
   }
  } while(0);
 }
 L105: do {
  if ((label|0) == 49) {
   $$17 = $$8$ph;
  }
  else if ((label|0) == 70) {
   $or$cond238 = $351 & $353;
   $spec$select239 = $or$cond238 ? -2 : -3;
   $$14$ph = $spec$select239;
   label = 71;
  }
  else if ((label|0) == 82) {
   switch ($$0$copyload$i|0) {
   case 611874402:  {
    break;
   }
   default: {
    $$17 = -3;
    break L105;
   }
   }
   HEAP32[$0>>2] = $51;
   $54 = ((($0)) + 24|0);
   HEAP32[$54>>2] = 1;
   $$17 = 0;
  }
 } while(0);
 if ((label|0) == 71) {
  $$17 = $$14$ph;
 }
 STACKTOP = sp;return ($$17|0);
}
function _lzfse_decode_v2_header_size($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 24|0);
 $2 = $1;
 $3 = $2;
 $4 = HEAPU8[$3>>0]|(HEAPU8[$3+1>>0]<<8)|(HEAPU8[$3+2>>0]<<16)|(HEAPU8[$3+3>>0]<<24);
 $5 = (($2) + 4)|0;
 $6 = $5;
 $7 = HEAPU8[$6>>0]|(HEAPU8[$6+1>>0]<<8)|(HEAPU8[$6+2>>0]<<16)|(HEAPU8[$6+3>>0]<<24);
 $8 = (_get_field($4,$7,0,32)|0);
 return ($8|0);
}
function _lzfse_decode_v1($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0109 = 0, $$082108 = 0, $$084107 = 0, $$091106 = 0, $$183$lcssa = 0, $$183103 = 0, $$185$lcssa = 0, $$185102 = 0, $$192$lcssa = 0, $$192101 = 0, $$2 = 0, $$286 = 0, $$390 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0;
 var $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0;
 var $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0;
 var $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0;
 var $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $9 = 0, $not$or$cond94 = 0, $or$cond = 0;
 var $or$cond100 = 0, $spec$select = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $2 = sp;
 _memset(($0|0),0,772)|0;
 $3 = ((($1)) + 8|0);
 $4 = $3;
 $5 = $4;
 $6 = HEAPU8[$5>>0]|(HEAPU8[$5+1>>0]<<8)|(HEAPU8[$5+2>>0]<<16)|(HEAPU8[$5+3>>0]<<24);
 $7 = (($4) + 4)|0;
 $8 = $7;
 $9 = HEAPU8[$8>>0]|(HEAPU8[$8+1>>0]<<8)|(HEAPU8[$8+2>>0]<<16)|(HEAPU8[$8+3>>0]<<24);
 $10 = ((($1)) + 16|0);
 $11 = $10;
 $12 = $11;
 $13 = HEAPU8[$12>>0]|(HEAPU8[$12+1>>0]<<8)|(HEAPU8[$12+2>>0]<<16)|(HEAPU8[$12+3>>0]<<24);
 $14 = (($11) + 4)|0;
 $15 = $14;
 $16 = HEAPU8[$15>>0]|(HEAPU8[$15+1>>0]<<8)|(HEAPU8[$15+2>>0]<<16)|(HEAPU8[$15+3>>0]<<24);
 $17 = ((($1)) + 24|0);
 $18 = $17;
 $19 = $18;
 $20 = HEAPU8[$19>>0]|(HEAPU8[$19+1>>0]<<8)|(HEAPU8[$19+2>>0]<<16)|(HEAPU8[$19+3>>0]<<24);
 $21 = (($18) + 4)|0;
 $22 = $21;
 $23 = HEAPU8[$22>>0]|(HEAPU8[$22+1>>0]<<8)|(HEAPU8[$22+2>>0]<<16)|(HEAPU8[$22+3>>0]<<24);
 HEAP32[$0>>2] = 829978210;
 $24 = ((($1)) + 4|0);
 $25 = HEAPU8[$24>>0]|(HEAPU8[$24+1>>0]<<8)|(HEAPU8[$24+2>>0]<<16)|(HEAPU8[$24+3>>0]<<24);
 $26 = ((($0)) + 4|0);
 HEAP32[$26>>2] = $25;
 $27 = (_get_field($6,$9,0,20)|0);
 $28 = ((($0)) + 12|0);
 HEAP32[$28>>2] = $27;
 $29 = (_get_field($6,$9,20,20)|0);
 $30 = ((($0)) + 20|0);
 HEAP32[$30>>2] = $29;
 $31 = (_get_field($6,$9,60,3)|0);
 $32 = (($31) + -7)|0;
 $33 = ((($0)) + 28|0);
 HEAP32[$33>>2] = $32;
 $34 = (_get_field($13,$16,0,10)|0);
 $35 = $34&65535;
 $36 = ((($0)) + 32|0);
 HEAP16[$36>>1] = $35;
 $37 = (_get_field($13,$16,10,10)|0);
 $38 = $37&65535;
 $39 = ((($0)) + 34|0);
 HEAP16[$39>>1] = $38;
 $40 = (_get_field($13,$16,20,10)|0);
 $41 = $40&65535;
 $42 = ((($0)) + 36|0);
 HEAP16[$42>>1] = $41;
 $43 = (_get_field($13,$16,30,10)|0);
 $44 = $43&65535;
 $45 = ((($0)) + 38|0);
 HEAP16[$45>>1] = $44;
 $46 = (_get_field($6,$9,40,20)|0);
 $47 = ((($0)) + 16|0);
 HEAP32[$47>>2] = $46;
 $48 = (_get_field($13,$16,40,20)|0);
 $49 = ((($0)) + 24|0);
 HEAP32[$49>>2] = $48;
 $50 = (_get_field($13,$16,60,3)|0);
 $51 = (($50) + -7)|0;
 $52 = ((($0)) + 40|0);
 HEAP32[$52>>2] = $51;
 $53 = (_get_field($20,$23,32,10)|0);
 $54 = $53&65535;
 $55 = ((($0)) + 44|0);
 HEAP16[$55>>1] = $54;
 $56 = (_get_field($20,$23,42,10)|0);
 $57 = $56&65535;
 $58 = ((($0)) + 46|0);
 HEAP16[$58>>1] = $57;
 $59 = (_get_field($20,$23,52,10)|0);
 $60 = $59&65535;
 $61 = ((($0)) + 48|0);
 HEAP16[$61>>1] = $60;
 $62 = (($48) + ($29))|0;
 $63 = ((($0)) + 8|0);
 HEAP32[$63>>2] = $62;
 $64 = ((($1)) + 32|0);
 $65 = (_get_field($20,$23,0,32)|0);
 $66 = (($1) + ($65)|0);
 $67 = ($66|0)==($64|0);
 L1: do {
  if ($67) {
   $$390 = 0;
  } else {
   $$0109 = 0;$$082108 = 0;$$084107 = 0;$$091106 = $64;
   while(1) {
    $68 = ($$091106>>>0)<($66>>>0);
    $69 = ($$082108|0)<(25);
    $or$cond100 = $68 & $69;
    if ($or$cond100) {
     $$183103 = $$082108;$$185102 = $$084107;$$192101 = $$091106;
     while(1) {
      $70 = (($$183103) + 8)|0;
      $71 = HEAP8[$$192101>>0]|0;
      $72 = $71&255;
      $73 = $72 << $$183103;
      $74 = $73 | $$185102;
      $75 = ((($$192101)) + 1|0);
      $76 = ($75>>>0)<($66>>>0);
      $77 = ($$183103|0)<(17);
      $or$cond = $76 & $77;
      if ($or$cond) {
       $$183103 = $70;$$185102 = $74;$$192101 = $75;
      } else {
       $$183$lcssa = $70;$$185$lcssa = $74;$$192$lcssa = $75;
       break;
      }
     }
    } else {
     $$183$lcssa = $$082108;$$185$lcssa = $$084107;$$192$lcssa = $$091106;
    }
    HEAP32[$2>>2] = 0;
    $78 = (_lzfse_decode_v1_freq_value($$185$lcssa,$2)|0);
    $79 = $78&65535;
    $80 = (((($0)) + 50|0) + ($$0109<<1)|0);
    HEAP16[$80>>1] = $79;
    $81 = HEAP32[$2>>2]|0;
    $82 = ($$183$lcssa|0)<($81|0);
    if ($82) {
     $$390 = -1;
     break L1;
    }
    $$2 = (($$183$lcssa) - ($81))|0;
    $$286 = $$185$lcssa >>> $81;
    $83 = (($$0109) + 1)|0;
    $84 = ($83>>>0)<(360);
    if ($84) {
     $$0109 = $83;$$082108 = $$2;$$084107 = $$286;$$091106 = $$192$lcssa;
    } else {
     break;
    }
   }
   $85 = ($$2|0)>(7);
   $86 = ($$192$lcssa|0)!=($66|0);
   $not$or$cond94 = $86 | $85;
   $spec$select = $not$or$cond94 << 31 >> 31;
   STACKTOP = sp;return ($spec$select|0);
  }
 } while(0);
 STACKTOP = sp;return ($$390|0);
}
function _fse_init_decoder_table($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$04859 = 0, $$04962 = 0, $$05261 = 0, $$05460 = 0, $$15058 = 0, $$153$ph = 0, $$251$ph = 0, $$sroa$0$0 = 0, $$sroa$0$0$in = 0, $$sroa$5$0$$sroa_raw_idx = 0, $$sroa$6$0 = 0, $$sroa$6$0$$sroa_idx = 0, $$sroa$6$0$in = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0;
 var $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $exitcond = 0;
 var $scevgep = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = (Math_clz32(($0|0))|0);
 $5 = ($1|0)>(0);
 L1: do {
  if ($5) {
   $6 = $0 << 1;
   $$04962 = $3;$$05261 = 0;$$05460 = 0;
   while(1) {
    $7 = (($2) + ($$05460<<1)|0);
    $8 = HEAP16[$7>>1]|0;
    $9 = $8&65535;
    $10 = ($8<<16>>16)==(0);
    if ($10) {
     $$153$ph = $$05261;$$251$ph = $$04962;
    } else {
     $11 = (($$05261) + ($9))|0;
     $12 = ($11|0)>($0|0);
     if ($12) {
      $29 = -1;
      break L1;
     }
     $13 = (Math_clz32(($9|0))|0);
     $14 = (($13) - ($4))|0;
     $15 = $6 >> $14;
     $16 = (($15) - ($9))|0;
     $17 = $$05460&255;
     $18 = (($14) + -1)|0;
     $$04859 = 0;$$15058 = $$04962;
     while(1) {
      $19 = ($$04859|0)<($16|0);
      if ($19) {
       $20 = (($$04859) + ($9))|0;
       $21 = $20 << $14;
       $22 = (($21) - ($0))|0;
       $$sroa$0$0$in = $14;$$sroa$6$0$in = $22;
      } else {
       $23 = (($$04859) - ($16))|0;
       $24 = $23 << $18;
       $$sroa$0$0$in = $18;$$sroa$6$0$in = $24;
      }
      $$sroa$0$0 = $$sroa$0$0$in&255;
      $$sroa$6$0 = $$sroa$6$0$in&65535;
      HEAP8[$$15058>>0] = $$sroa$0$0;
      $$sroa$5$0$$sroa_raw_idx = ((($$15058)) + 1|0);
      HEAP8[$$sroa$5$0$$sroa_raw_idx>>0] = $17;
      $$sroa$6$0$$sroa_idx = ((($$15058)) + 2|0);
      HEAP16[$$sroa$6$0$$sroa_idx>>1] = $$sroa$6$0;
      $25 = ((($$15058)) + 4|0);
      $26 = (($$04859) + 1)|0;
      $exitcond = ($26|0)==($9|0);
      if ($exitcond) {
       break;
      } else {
       $$04859 = $26;$$15058 = $25;
      }
     }
     $scevgep = (($$04962) + ($9<<2)|0);
     $$153$ph = $11;$$251$ph = $scevgep;
    }
    $27 = (($$05460) + 1)|0;
    $28 = ($27|0)<($1|0);
    if ($28) {
     $$04962 = $$251$ph;$$05261 = $$153$ph;$$05460 = $27;
    } else {
     $29 = 0;
     break;
    }
   }
  } else {
   $29 = 0;
  }
 } while(0);
 return ($29|0);
}
function _fse_init_value_decoder_table($0,$1,$2,$3,$4,$5) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 var $$06267 = 0, $$06365 = 0, $$068 = 0, $$166 = 0, $$2 = 0, $$pn = 0, $$sroa$0$0 = 0, $$sroa$0$0$in = 0, $$sroa$10$0$$sroa_idx11 = 0, $$sroa$6$0$$sroa_idx3 = 0, $$sroa$8$0 = 0, $$sroa$8$0$$sroa_idx7 = 0, $$sroa$8$0$in = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0;
 var $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
 var $exitcond = 0, $exitcond70 = 0, $scevgep = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $6 = (Math_clz32(($0|0))|0);
 $7 = ($1|0)>(0);
 if ($7) {
  $8 = $0 << 1;
  $$06267 = 0;$$068 = $5;
  while(1) {
   $9 = (($2) + ($$06267<<1)|0);
   $10 = HEAP16[$9>>1]|0;
   $11 = $10&65535;
   $12 = ($10<<16>>16)==(0);
   if ($12) {
    $$2 = $$068;
   } else {
    $13 = (Math_clz32(($11|0))|0);
    $14 = (($13) - ($6))|0;
    $15 = $8 >> $14;
    $16 = (($15) - ($11))|0;
    $17 = (($3) + ($$06267)|0);
    $18 = HEAP8[$17>>0]|0;
    $19 = (($4) + ($$06267<<2)|0);
    $20 = HEAP32[$19>>2]|0;
    $21 = $14 & 255;
    $22 = $18&255;
    $23 = (($14) + -1)|0;
    $$06365 = 0;$$166 = $$068;
    while(1) {
     $24 = ($$06365|0)<($16|0);
     if ($24) {
      $25 = (($$06365) + ($11))|0;
      $26 = $25 << $14;
      $27 = (($26) - ($0))|0;
      $$pn = $21;$$sroa$8$0$in = $27;
     } else {
      $28 = (($$06365) - ($16))|0;
      $29 = $28 << $23;
      $$pn = $23;$$sroa$8$0$in = $29;
     }
     $$sroa$0$0$in = (($$pn) + ($22))|0;
     $$sroa$0$0 = $$sroa$0$0$in&255;
     $$sroa$8$0 = $$sroa$8$0$in&65535;
     HEAP8[$$166>>0] = $$sroa$0$0;
     $$sroa$6$0$$sroa_idx3 = ((($$166)) + 1|0);
     HEAP8[$$sroa$6$0$$sroa_idx3>>0] = $18;
     $$sroa$8$0$$sroa_idx7 = ((($$166)) + 2|0);
     HEAP16[$$sroa$8$0$$sroa_idx7>>1] = $$sroa$8$0;
     $$sroa$10$0$$sroa_idx11 = ((($$166)) + 4|0);
     HEAP32[$$sroa$10$0$$sroa_idx11>>2] = $20;
     $30 = ((($$166)) + 8|0);
     $31 = (($$06365) + 1)|0;
     $exitcond = ($31|0)==($11|0);
     if ($exitcond) {
      break;
     } else {
      $$06365 = $31;$$166 = $30;
     }
    }
    $scevgep = (($$068) + ($11<<3)|0);
    $$2 = $scevgep;
   }
   $32 = (($$06267) + 1)|0;
   $exitcond70 = ($32|0)==($1|0);
   if ($exitcond70) {
    break;
   } else {
    $$06267 = $32;$$068 = $$2;
   }
  }
 }
 return;
}
function _fse_mask_lsb32_17($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = (4528 + ($1<<2)|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = $3 & $0;
 return ($4|0);
}
function _lzfse_decode_lmd($0) {
 $0 = $0|0;
 var $$0174262 = 0, $$0175257 = 0, $$0176266 = 0, $$0177270 = 0, $$0178 = 0, $$0179 = 0, $$0180 = 0, $$0182 = 0, $$0184 = 0, $$0186 = 0, $$0188 = 0, $$0190 = 0, $$0242 = 0, $$0244 = 0, $$0246 = 0, $$0258 = 0, $$1 = 0, $$1181 = 0, $$1183 = 0, $$1185 = 0;
 var $$1187 = 0, $$1189 = 0, $$1191 = 0, $$1243 = 0, $$1245 = 0, $$1247 = 0, $$2 = 0, $$2192 = 0, $$sroa$0$0 = 0, $$sroa$0$0$$sroa_idx$i = 0, $$sroa$0$0$$sroa_idx$i196 = 0, $$sroa$0$0$$sroa_idx$i207 = 0, $$sroa$0$0$copyload$i = 0, $$sroa$0$0$copyload$i197 = 0, $$sroa$0$0$copyload$i208 = 0, $$sroa$0$1$ph = 0, $$sroa$0$2$ph = 0, $$sroa$0$3$ph = 0, $$sroa$0$4 = 0, $$sroa$0218$0 = 0;
 var $$sroa$0218$1$ph = 0, $$sroa$0218$2$ph = 0, $$sroa$0218$3$ph = 0, $$sroa$0218$4 = 0, $$sroa$16$0 = 0, $$sroa$16$1$ph = 0, $$sroa$16$2$ph = 0, $$sroa$16$3$ph = 0, $$sroa$16$4 = 0, $$sroa$4$0$$sroa_idx$i = 0, $$sroa$4$0$$sroa_idx$i198 = 0, $$sroa$4$0$$sroa_idx$i209 = 0, $$sroa$4$0$copyload$i = 0, $$sroa$4$0$copyload$i199 = 0, $$sroa$4$0$copyload$i210 = 0, $$sroa$6$0$$sroa_idx4$i = 0, $$sroa$6$0$$sroa_idx4$i200 = 0, $$sroa$6$0$$sroa_idx4$i211 = 0, $$sroa$6$0$copyload$i = 0, $$sroa$6$0$copyload$i201 = 0;
 var $$sroa$6$0$copyload$i212 = 0, $$sroa$7$0$$sroa_idx6$i = 0, $$sroa$7$0$$sroa_idx6$i202 = 0, $$sroa$7$0$$sroa_idx6$i213 = 0, $$sroa$7$0$copyload$i = 0, $$sroa$7$0$copyload$i203 = 0, $$sroa$7$0$copyload$i214 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0;
 var $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0;
 var $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0;
 var $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0, $161 = 0, $162 = 0, $163 = 0, $164 = 0;
 var $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0, $18 = 0, $180 = 0, $181 = 0, $182 = 0;
 var $183 = 0, $184 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0;
 var $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0;
 var $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0;
 var $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0;
 var $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $exitcond = 0, $exitcond273 = 0, $exitcond274 = 0, $exitcond275 = 0, $exitcond276 = 0, $or$cond = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 68|0);
 $2 = HEAP16[$1>>1]|0;
 $3 = ((($0)) + 70|0);
 $4 = HEAP16[$3>>1]|0;
 $5 = ((($0)) + 72|0);
 $6 = HEAP16[$5>>1]|0;
 $7 = ((($0)) + 56|0);
 $8 = $7;
 $9 = $8;
 $10 = HEAP32[$9>>2]|0;
 $11 = (($8) + 4)|0;
 $12 = $11;
 $13 = HEAP32[$12>>2]|0;
 $14 = ((($0)) + 4|0);
 $15 = HEAP32[$14>>2]|0;
 $16 = HEAP32[$0>>2]|0;
 $17 = ((($0)) + 64|0);
 $18 = HEAP32[$17>>2]|0;
 $19 = (($16) + ($18)|0);
 $20 = $19;
 $21 = ((($0)) + 40|0);
 $22 = HEAP32[$21>>2]|0;
 $23 = ((($0)) + 12|0);
 $24 = HEAP32[$23>>2]|0;
 $25 = ((($0)) + 32|0);
 $26 = HEAP32[$25>>2]|0;
 $27 = ((($0)) + 44|0);
 $28 = HEAP32[$27>>2]|0;
 $29 = ((($0)) + 48|0);
 $30 = HEAP32[$29>>2]|0;
 $31 = ((($0)) + 52|0);
 $32 = HEAP32[$31>>2]|0;
 $33 = ((($0)) + 20|0);
 $34 = HEAP32[$33>>2]|0;
 $35 = $24;
 $36 = (($34) - ($35))|0;
 $37 = (($36) + -32)|0;
 $38 = $30 | $28;
 $39 = ($38|0)==(0);
 if ($39) {
  $$0179 = $37;$$0180 = $32;$$0186 = $26;$$0188 = $24;$$0190 = $22;$$0242 = $6;$$0244 = $4;$$0246 = $2;$$sroa$0$0 = $20;$$sroa$0218$0 = $10;$$sroa$16$0 = $13;
  label = 2;
 } else {
  $$0182 = $30;$$0184 = $28;$$1 = $37;$$1181 = $32;$$1187 = $26;$$1189 = $24;$$1191 = $22;$$1243 = $6;$$1245 = $4;$$1247 = $2;$$sroa$0$4 = $20;$$sroa$0218$4 = $10;$$sroa$16$4 = $13;
 }
 while(1) {
  if ((label|0) == 2) {
   label = 0;
   $40 = ($$0186|0)==(0);
   if ($40) {
    label = 40;
    break;
   }
   $41 = (31 - ($$sroa$16$0))|0;
   $42 = $41 & -8;
   $43 = ($42|0)>(0);
   if ($43) {
    $44 = $$sroa$0$0;
    $45 = $41 >> 3;
    $46 = (0 - ($45))|0;
    $47 = (($44) + ($46)|0);
    $48 = ($47>>>0)<($15>>>0);
    if ($48) {
     $$0178 = -3;
     break;
    }
    $49 = (($42) + ($$sroa$16$0))|0;
    $50 = $$sroa$0218$0 << $42;
    $51 = $47;
    $52 = HEAP32[$47>>2]|0;
    $53 = (_fse_mask_lsb32_17($52,$42)|0);
    $54 = $53 | $50;
    $$sroa$0$1$ph = $51;$$sroa$0218$1$ph = $54;$$sroa$16$1$ph = $49;
   } else {
    $$sroa$0$1$ph = $$sroa$0$0;$$sroa$0218$1$ph = $$sroa$0218$0;$$sroa$16$1$ph = $$sroa$16$0;
   }
   $55 = $$0246&65535;
   $$sroa$0$0$$sroa_idx$i = (((($0)) + 80|0) + ($55<<3)|0);
   $$sroa$0$0$copyload$i = HEAP8[$$sroa$0$0$$sroa_idx$i>>0]|0;
   $$sroa$4$0$$sroa_idx$i = (((((($0)) + 80|0) + ($55<<3)|0)) + 1|0);
   $$sroa$4$0$copyload$i = HEAP8[$$sroa$4$0$$sroa_idx$i>>0]|0;
   $$sroa$6$0$$sroa_idx4$i = (((((($0)) + 80|0) + ($55<<3)|0)) + 2|0);
   $$sroa$6$0$copyload$i = HEAP16[$$sroa$6$0$$sroa_idx4$i>>1]|0;
   $$sroa$7$0$$sroa_idx6$i = (((((($0)) + 80|0) + ($55<<3)|0)) + 4|0);
   $$sroa$7$0$copyload$i = HEAP32[$$sroa$7$0$$sroa_idx6$i>>2]|0;
   $56 = $$sroa$0$0$copyload$i&255;
   $57 = (($$sroa$16$1$ph) - ($56))|0;
   $58 = $$sroa$0218$1$ph >>> $57;
   $59 = (_fse_mask_lsb32_17($$sroa$0218$1$ph,$57)|0);
   $60 = $$sroa$6$0$copyload$i&65535;
   $61 = $$sroa$4$0$copyload$i&255;
   $62 = $58 >>> $61;
   $63 = (($62) + ($60))|0;
   $64 = $63&65535;
   $65 = (_fse_mask_lsb32_17($58,$61)|0);
   $66 = (($65) + ($$sroa$7$0$copyload$i))|0;
   $67 = (($$0190) + ($66)|0);
   $68 = ((($0)) + 47312|0);
   $69 = ($67>>>0)<($68>>>0);
   if (!($69)) {
    $$0178 = -3;
    break;
   }
   $70 = (31 - ($57))|0;
   $71 = $70 & -8;
   $72 = ($71|0)>(0);
   if ($72) {
    $73 = $$sroa$0$1$ph;
    $74 = $70 >> 3;
    $75 = (0 - ($74))|0;
    $76 = (($73) + ($75)|0);
    $77 = ($76>>>0)<($15>>>0);
    if ($77) {
     $$0178 = -3;
     break;
    }
    $78 = (($71) + ($57))|0;
    $79 = $59 << $71;
    $80 = $76;
    $81 = HEAP32[$76>>2]|0;
    $82 = (_fse_mask_lsb32_17($81,$71)|0);
    $83 = $82 | $79;
    $$sroa$0$2$ph = $80;$$sroa$0218$2$ph = $83;$$sroa$16$2$ph = $78;
   } else {
    $$sroa$0$2$ph = $$sroa$0$1$ph;$$sroa$0218$2$ph = $59;$$sroa$16$2$ph = $57;
   }
   $84 = $$0244&65535;
   $$sroa$0$0$$sroa_idx$i196 = (((($0)) + 592|0) + ($84<<3)|0);
   $$sroa$0$0$copyload$i197 = HEAP8[$$sroa$0$0$$sroa_idx$i196>>0]|0;
   $$sroa$4$0$$sroa_idx$i198 = (((((($0)) + 592|0) + ($84<<3)|0)) + 1|0);
   $$sroa$4$0$copyload$i199 = HEAP8[$$sroa$4$0$$sroa_idx$i198>>0]|0;
   $$sroa$6$0$$sroa_idx4$i200 = (((((($0)) + 592|0) + ($84<<3)|0)) + 2|0);
   $$sroa$6$0$copyload$i201 = HEAP16[$$sroa$6$0$$sroa_idx4$i200>>1]|0;
   $$sroa$7$0$$sroa_idx6$i202 = (((((($0)) + 592|0) + ($84<<3)|0)) + 4|0);
   $$sroa$7$0$copyload$i203 = HEAP32[$$sroa$7$0$$sroa_idx6$i202>>2]|0;
   $85 = $$sroa$0$0$copyload$i197&255;
   $86 = (($$sroa$16$2$ph) - ($85))|0;
   $87 = $$sroa$0218$2$ph >>> $86;
   $88 = (_fse_mask_lsb32_17($$sroa$0218$2$ph,$86)|0);
   $89 = $$sroa$6$0$copyload$i201&65535;
   $90 = $$sroa$4$0$copyload$i199&255;
   $91 = $87 >>> $90;
   $92 = (($91) + ($89))|0;
   $93 = $92&65535;
   $94 = (_fse_mask_lsb32_17($87,$90)|0);
   $95 = (($94) + ($$sroa$7$0$copyload$i203))|0;
   $96 = (31 - ($86))|0;
   $97 = $96 & -8;
   $98 = ($97|0)>(0);
   if ($98) {
    $99 = $$sroa$0$2$ph;
    $100 = $96 >> 3;
    $101 = (0 - ($100))|0;
    $102 = (($99) + ($101)|0);
    $103 = ($102>>>0)<($15>>>0);
    if ($103) {
     $$0178 = -3;
     break;
    }
    $104 = (($97) + ($86))|0;
    $105 = $88 << $97;
    $106 = $102;
    $107 = HEAP32[$102>>2]|0;
    $108 = (_fse_mask_lsb32_17($107,$97)|0);
    $109 = $108 | $105;
    $$sroa$0$3$ph = $106;$$sroa$0218$3$ph = $109;$$sroa$16$3$ph = $104;
   } else {
    $$sroa$0$3$ph = $$sroa$0$2$ph;$$sroa$0218$3$ph = $88;$$sroa$16$3$ph = $86;
   }
   $110 = $$0242&65535;
   $$sroa$0$0$$sroa_idx$i207 = (((($0)) + 1104|0) + ($110<<3)|0);
   $$sroa$0$0$copyload$i208 = HEAP8[$$sroa$0$0$$sroa_idx$i207>>0]|0;
   $$sroa$4$0$$sroa_idx$i209 = (((((($0)) + 1104|0) + ($110<<3)|0)) + 1|0);
   $$sroa$4$0$copyload$i210 = HEAP8[$$sroa$4$0$$sroa_idx$i209>>0]|0;
   $$sroa$6$0$$sroa_idx4$i211 = (((((($0)) + 1104|0) + ($110<<3)|0)) + 2|0);
   $$sroa$6$0$copyload$i212 = HEAP16[$$sroa$6$0$$sroa_idx4$i211>>1]|0;
   $$sroa$7$0$$sroa_idx6$i213 = (((((($0)) + 1104|0) + ($110<<3)|0)) + 4|0);
   $$sroa$7$0$copyload$i214 = HEAP32[$$sroa$7$0$$sroa_idx6$i213>>2]|0;
   $111 = $$sroa$0$0$copyload$i208&255;
   $112 = (($$sroa$16$3$ph) - ($111))|0;
   $113 = $$sroa$0218$3$ph >>> $112;
   $114 = (_fse_mask_lsb32_17($$sroa$0218$3$ph,$112)|0);
   $115 = $$sroa$6$0$copyload$i212&65535;
   $116 = $$sroa$4$0$copyload$i210&255;
   $117 = $113 >>> $116;
   $118 = (($117) + ($115))|0;
   $119 = $118&65535;
   $120 = (_fse_mask_lsb32_17($113,$116)|0);
   $121 = (($120) + ($$sroa$7$0$copyload$i214))|0;
   $122 = ($121|0)==(0);
   $123 = $122 ? $$0180 : $121;
   $124 = (($$0186) + -1)|0;
   $$0182 = $95;$$0184 = $66;$$1 = $$0179;$$1181 = $123;$$1187 = $124;$$1189 = $$0188;$$1191 = $$0190;$$1243 = $119;$$1245 = $93;$$1247 = $64;$$sroa$0$4 = $$sroa$0$3$ph;$$sroa$0218$4 = $114;$$sroa$16$4 = $112;
  }
  $125 = (($$1189) + ($$0184)|0);
  $126 = ((($0)) + 16|0);
  $127 = HEAP32[$126>>2]|0;
  $128 = $125;
  $129 = (($128) - ($127))|0;
  $130 = ($$1181>>>0)>($129>>>0);
  if ($130) {
   $$0178 = -3;
   break;
  }
  $131 = (($$0182) + ($$0184))|0;
  $132 = ($$1|0)<($131|0);
  if (!($132)) {
   $133 = (($$1) - ($131))|0;
   _copy($$1189,$$1191,$$0184);
   $134 = (($$1191) + ($$0184)|0);
   $135 = ($$1181|0)<(8);
   $136 = ($$1181|0)<($$0182|0);
   $or$cond = $135 & $136;
   if ($or$cond) {
    $139 = ($$0182|0)==(0);
    if (!($139)) {
     $$0177270 = 0;
     while(1) {
      $140 = (($$0177270) - ($$1181))|0;
      $141 = (($125) + ($140)|0);
      $142 = HEAP8[$141>>0]|0;
      $143 = (($125) + ($$0177270)|0);
      HEAP8[$143>>0] = $142;
      $144 = (($$0177270) + 1)|0;
      $exitcond276 = ($144|0)==($$0182|0);
      if ($exitcond276) {
       break;
      } else {
       $$0177270 = $144;
      }
     }
    }
   } else {
    $137 = (0 - ($$1181))|0;
    $138 = (($125) + ($137)|0);
    _copy($125,$138,$$0182);
   }
   $145 = (($125) + ($$0182)|0);
   $$0179 = $133;$$0180 = $$1181;$$0186 = $$1187;$$0188 = $145;$$0190 = $134;$$0242 = $$1243;$$0244 = $$1245;$$0246 = $$1247;$$sroa$0$0 = $$sroa$0$4;$$sroa$0218$0 = $$sroa$0218$4;$$sroa$16$0 = $$sroa$16$4;
   label = 2;
   continue;
  }
  $146 = (($$1) + 32)|0;
  $147 = ($$0184|0)>($146|0);
  if ($147) {
   label = 27;
   break;
  }
  $148 = ($$0184|0)==(0);
  if (!($148)) {
   $$0176266 = 0;
   while(1) {
    $152 = (($$1191) + ($$0176266)|0);
    $153 = HEAP8[$152>>0]|0;
    $154 = (($$1189) + ($$0176266)|0);
    HEAP8[$154>>0] = $153;
    $155 = (($$0176266) + 1)|0;
    $exitcond275 = ($155|0)==($$0184|0);
    if ($exitcond275) {
     break;
    } else {
     $$0176266 = $155;
    }
   }
  }
  $149 = (($$1191) + ($$0184)|0);
  $150 = (($146) - ($$0184))|0;
  $151 = ($$0182|0)>($150|0);
  if ($151) {
   label = 35;
   break;
  }
  $163 = ($$0182|0)==(0);
  if (!($163)) {
   $$0174262 = 0;
   while(1) {
    $167 = (($$0174262) - ($$1181))|0;
    $168 = (($125) + ($167)|0);
    $169 = HEAP8[$168>>0]|0;
    $170 = (($125) + ($$0174262)|0);
    HEAP8[$170>>0] = $169;
    $171 = (($$0174262) + 1)|0;
    $exitcond274 = ($171|0)==($$0182|0);
    if ($exitcond274) {
     break;
    } else {
     $$0174262 = $171;
    }
   }
  }
  $164 = (($125) + ($$0182)|0);
  $165 = (-32 - ($$0182))|0;
  $166 = (($165) + ($150))|0;
  $$0179 = $166;$$0180 = $$1181;$$0186 = $$1187;$$0188 = $164;$$0190 = $149;$$0242 = $$1243;$$0244 = $$1245;$$0246 = $$1247;$$sroa$0$0 = $$sroa$0$4;$$sroa$0218$0 = $$sroa$0218$4;$$sroa$16$0 = $$sroa$16$4;
  label = 2;
 }
 if ((label|0) == 27) {
  $156 = ($146|0)==(0);
  if (!($156)) {
   $$0175257 = 0;
   while(1) {
    $159 = (($$1191) + ($$0175257)|0);
    $160 = HEAP8[$159>>0]|0;
    $161 = (($$1189) + ($$0175257)|0);
    HEAP8[$161>>0] = $160;
    $162 = (($$0175257) + 1)|0;
    $exitcond = ($162|0)==($146|0);
    if ($exitcond) {
     break;
    } else {
     $$0175257 = $162;
    }
   }
  }
  $157 = (($$1191) + ($146)|0);
  $158 = (($$0184) - ($146))|0;
  $$1183 = $$0182;$$1185 = $158;$$2192 = $157;
  label = 39;
 }
 else if ((label|0) == 35) {
  $172 = ($150|0)==(0);
  if (!($172)) {
   $$0258 = 0;
   while(1) {
    $174 = (($$0258) - ($$1181))|0;
    $175 = (($125) + ($174)|0);
    $176 = HEAP8[$175>>0]|0;
    $177 = (($125) + ($$0258)|0);
    HEAP8[$177>>0] = $176;
    $178 = (($$0258) + 1)|0;
    $exitcond273 = ($178|0)==($150|0);
    if ($exitcond273) {
     break;
    } else {
     $$0258 = $178;
    }
   }
  }
  $173 = (($$0182) - ($150))|0;
  $$1183 = $173;$$1185 = 0;$$2192 = $149;
  label = 39;
 }
 else if ((label|0) == 40) {
  HEAP32[$23>>2] = $$0188;
  $$0178 = 0;
 }
 if ((label|0) == 39) {
  $$2 = (($$1189) + ($146)|0);
  HEAP32[$27>>2] = $$1185;
  HEAP32[$29>>2] = $$1183;
  HEAP32[$31>>2] = $$1181;
  HEAP16[$1>>1] = $$1247;
  HEAP16[$3>>1] = $$1245;
  HEAP16[$5>>1] = $$1243;
  $179 = $7;
  $180 = $179;
  HEAP32[$180>>2] = $$sroa$0218$4;
  $181 = (($179) + 4)|0;
  $182 = $181;
  HEAP32[$182>>2] = $$sroa$16$4;
  HEAP32[$25>>2] = $$1187;
  $183 = HEAP32[$0>>2]|0;
  $184 = (($$sroa$0$4) - ($183))|0;
  HEAP32[$17>>2] = $184;
  HEAP32[$21>>2] = $$2192;
  HEAP32[$23>>2] = $$2;
  $$0178 = -2;
 }
 return ($$0178|0);
}
function _lzvn_decode($0) {
 $0 = $0|0;
 var $$0$copyload$i328 = 0, $$0$copyload$i330 = 0, $$0$copyload$i332 = 0, $$0290380 = 0, $$0291383 = 0, $$0292364 = 0, $$0293366 = 0, $$0294363 = 0, $$0295369 = 0, $$0296373 = 0, $$0297 = 0, $$0299 = 0, $$0301 = 0, $$0303 = 0, $$0305 = 0, $$0309 = 0, $$0313 = 0, $$0317 = 0, $$0376 = 0, $$1 = 0;
 var $$1300 = 0, $$1302 = 0, $$1304 = 0, $$1306 = 0, $$1310 = 0, $$1314 = 0, $$1318 = 0, $$2 = 0, $$2307 = 0, $$2311 = 0, $$2315 = 0, $$2319 = 0, $$3 = 0, $$3$ph = 0, $$3308$ph = 0, $$3312$ph = 0, $$3316 = 0, $$3320$ph = 0, $$sink = 0, $$sink471$sink = 0;
 var $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0;
 var $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0;
 var $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0;
 var $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0, $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0;
 var $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0, $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0;
 var $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0, $198 = 0, $199 = 0, $2 = 0, $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0;
 var $207 = 0, $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0;
 var $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0;
 var $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0;
 var $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0;
 var $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $addconv = 0, $addconv333 = 0, $addconv334 = 0, $exitcond = 0, $exitcond412 = 0, $exitcond413 = 0, $exitcond414 = 0;
 var $exitcond415 = 0, $exitcond416 = 0, $indirectbr_cast = 0, $or$cond = 0, $or$cond321 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 4|0);
 $2 = HEAP32[$1>>2]|0;
 $3 = HEAP32[$0>>2]|0;
 $4 = $3;
 $5 = (($2) - ($4))|0;
 $6 = ((($0)) + 16|0);
 $7 = HEAP32[$6>>2]|0;
 $8 = ((($0)) + 8|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = $9;
 $11 = (($7) - ($10))|0;
 $12 = ($5|0)==(0);
 $13 = ($11|0)==(0);
 $or$cond = $12 | $13;
 L1: do {
  if (!($or$cond)) {
   $14 = ((($0)) + 36|0);
   $15 = ((($0)) + 24|0);
   $16 = HEAP32[$15>>2]|0;
   $17 = ($16|0)==(0);
   $18 = ((($0)) + 28|0);
   $19 = HEAP32[$18>>2]|0;
   if ($17) {
    $20 = HEAP32[$14>>2]|0;
    $21 = ($19|0)==(0);
    if ($21) {
     $$3$ph = $5;$$3308$ph = $20;$$3312$ph = $9;$$3320$ph = $11;$$sink = $3;
     label = 58;
    } else {
     $22 = ((($0)) + 32|0);
     $23 = HEAP32[$22>>2]|0;
     HEAP32[$22>>2] = 0;
     HEAP32[$18>>2] = 0;
     HEAP32[$15>>2] = 0;
     $$1 = $5;$$1304 = $19;$$1306 = $23;$$1310 = $9;$$1314 = $3;$$1318 = $11;
     label = 24;
    }
   } else {
    $24 = ((($0)) + 32|0);
    $25 = HEAP32[$24>>2]|0;
    HEAP32[$24>>2] = 0;
    HEAP32[$18>>2] = 0;
    HEAP32[$15>>2] = 0;
    $26 = ($19|0)==(0);
    if ($26) {
     $$1300 = 0;$$1302 = $16;$$2 = $5;$$2307 = $25;$$2311 = $9;$$2315 = $3;$$2319 = $11;
     label = 44;
    } else {
     $$0297 = $5;$$0299 = 0;$$0301 = $16;$$0303 = $19;$$0305 = $25;$$0309 = $9;$$0313 = $3;$$0317 = $11;
     label = 13;
    }
   }
   L7: while(1) {
    if ((label|0) == 13) {
     label = 0;
     $72 = (($$0313) + ($$0299)|0);
     $73 = (($$0297) - ($$0299))|0;
     $74 = ($$0317>>>0)>(3);
     $75 = ($73>>>0)>(3);
     $76 = $74 & $75;
     if ($76) {
      $$0$copyload$i328 = HEAPU8[$72>>0]|(HEAPU8[$72+1>>0]<<8)|(HEAPU8[$72+2>>0]<<16)|(HEAPU8[$72+3>>0]<<24);
      HEAP8[$$0309>>0]=$$0$copyload$i328&255;HEAP8[$$0309+1>>0]=($$0$copyload$i328>>8)&255;HEAP8[$$0309+2>>0]=($$0$copyload$i328>>16)&255;HEAP8[$$0309+3>>0]=$$0$copyload$i328>>24;
     } else {
      $77 = ($$0301>>>0)>($$0317>>>0);
      if ($77) {
       label = 19;
       break;
      }
      $78 = ($$0301|0)==(0);
      if (!($78)) {
       $$0296373 = 0;
       while(1) {
        $79 = (($72) + ($$0296373)|0);
        $80 = HEAP8[$79>>0]|0;
        $81 = (($$0309) + ($$0296373)|0);
        HEAP8[$81>>0] = $80;
        $82 = (($$0296373) + 1)|0;
        $exitcond414 = ($82|0)==($$0301|0);
        if ($exitcond414) {
         break;
        } else {
         $$0296373 = $82;
        }
       }
      }
     }
     $93 = (($$0309) + ($$0301)|0);
     $94 = (($$0317) - ($$0301))|0;
     $95 = (($72) + ($$0301)|0);
     $96 = (($73) - ($$0301))|0;
     $97 = ((($0)) + 12|0);
     $98 = HEAP32[$97>>2]|0;
     $99 = $93;
     $100 = (($99) - ($98))|0;
     $101 = (($$0305) + -1)|0;
     $102 = ($101>>>0)<($100>>>0);
     if ($102) {
      $$1 = $96;$$1304 = $$0303;$$1306 = $$0305;$$1310 = $93;$$1314 = $95;$$1318 = $94;
      label = 24;
      continue;
     } else {
      break L1;
     }
    }
    else if ((label|0) == 24) {
     label = 0;
     $103 = (($$1304) + 7)|0;
     $104 = ($$1318>>>0)>=($103>>>0);
     $105 = ($$1306>>>0)>(7);
     $106 = $105 & $104;
     if ($106) {
      $107 = ($$1304|0)==(0);
      if (!($107)) {
       $$0294363 = 0;
       while(1) {
        $108 = (($$1310) + ($$0294363)|0);
        $109 = (($$0294363) - ($$1306))|0;
        $110 = (($$1310) + ($109)|0);
        $111 = $110;
        $112 = $111;
        $113 = HEAPU8[$112>>0]|(HEAPU8[$112+1>>0]<<8)|(HEAPU8[$112+2>>0]<<16)|(HEAPU8[$112+3>>0]<<24);
        $114 = (($111) + 4)|0;
        $115 = $114;
        $116 = HEAPU8[$115>>0]|(HEAPU8[$115+1>>0]<<8)|(HEAPU8[$115+2>>0]<<16)|(HEAPU8[$115+3>>0]<<24);
        $117 = $108;
        $118 = $117;
        HEAP8[$118>>0]=$113&255;HEAP8[$118+1>>0]=($113>>8)&255;HEAP8[$118+2>>0]=($113>>16)&255;HEAP8[$118+3>>0]=$113>>24;
        $119 = (($117) + 4)|0;
        $120 = $119;
        HEAP8[$120>>0]=$116&255;HEAP8[$120+1>>0]=($116>>8)&255;HEAP8[$120+2>>0]=($116>>16)&255;HEAP8[$120+3>>0]=$116>>24;
        $121 = (($$0294363) + 8)|0;
        $122 = ($121>>>0)<($$1304>>>0);
        if ($122) {
         $$0294363 = $121;
        } else {
         break;
        }
       }
      }
     } else {
      $123 = ($$1304>>>0)>($$1318>>>0);
      if ($123) {
       label = 32;
       break;
      }
      $124 = ($$1304|0)==(0);
      if (!($124)) {
       $$0293366 = 0;
       while(1) {
        $125 = (($$0293366) - ($$1306))|0;
        $126 = (($$1310) + ($125)|0);
        $127 = HEAP8[$126>>0]|0;
        $128 = (($$1310) + ($$0293366)|0);
        HEAP8[$128>>0] = $127;
        $129 = (($$0293366) + 1)|0;
        $exitcond412 = ($129|0)==($$1304|0);
        if ($exitcond412) {
         break;
        } else {
         $$0293366 = $129;
        }
       }
      }
     }
     $140 = (($$1310) + ($$1304)|0);
     $141 = (($$1318) - ($$1304))|0;
     $$3$ph = $$1;$$3308$ph = $$1306;$$3312$ph = $140;$$3320$ph = $141;$$sink = $$1314;
     label = 58;
     continue;
    }
    else if ((label|0) == 44) {
     label = 0;
     $161 = (($$1300) + ($$1302))|0;
     $162 = ($$2>>>0)>($161>>>0);
     if (!($162)) {
      break L1;
     }
     $163 = (($$2315) + ($$1300)|0);
     $164 = (($$2) - ($$1300))|0;
     $165 = (($$1302) + 7)|0;
     $166 = ($$2319>>>0)<($165>>>0);
     $167 = ($164>>>0)<($165>>>0);
     $or$cond321 = $166 | $167;
     if ($or$cond321) {
      $183 = ($$1302>>>0)>($$2319>>>0);
      if ($183) {
       label = 53;
       break;
      }
      $184 = ($$1302|0)==(0);
      if (!($184)) {
       $$0290380 = 0;
       while(1) {
        $185 = (($163) + ($$0290380)|0);
        $186 = HEAP8[$185>>0]|0;
        $187 = (($$2311) + ($$0290380)|0);
        HEAP8[$187>>0] = $186;
        $188 = (($$0290380) + 1)|0;
        $exitcond416 = ($188|0)==($$1302|0);
        if ($exitcond416) {
         break;
        } else {
         $$0290380 = $188;
        }
       }
      }
     } else {
      $168 = ($$1302|0)==(0);
      if (!($168)) {
       $$0291383 = 0;
       while(1) {
        $169 = (($$2311) + ($$0291383)|0);
        $170 = (($163) + ($$0291383)|0);
        $171 = $170;
        $172 = $171;
        $173 = HEAPU8[$172>>0]|(HEAPU8[$172+1>>0]<<8)|(HEAPU8[$172+2>>0]<<16)|(HEAPU8[$172+3>>0]<<24);
        $174 = (($171) + 4)|0;
        $175 = $174;
        $176 = HEAPU8[$175>>0]|(HEAPU8[$175+1>>0]<<8)|(HEAPU8[$175+2>>0]<<16)|(HEAPU8[$175+3>>0]<<24);
        $177 = $169;
        $178 = $177;
        HEAP8[$178>>0]=$173&255;HEAP8[$178+1>>0]=($173>>8)&255;HEAP8[$178+2>>0]=($173>>16)&255;HEAP8[$178+3>>0]=$173>>24;
        $179 = (($177) + 4)|0;
        $180 = $179;
        HEAP8[$180>>0]=$176&255;HEAP8[$180+1>>0]=($176>>8)&255;HEAP8[$180+2>>0]=($176>>16)&255;HEAP8[$180+3>>0]=$176>>24;
        $181 = (($$0291383) + 8)|0;
        $182 = ($181>>>0)<($$1302>>>0);
        if ($182) {
         $$0291383 = $181;
        } else {
         break;
        }
       }
      }
     }
     $199 = (($$2311) + ($$1302)|0);
     $200 = (($$2319) - ($$1302))|0;
     $201 = (($163) + ($$1302)|0);
     $202 = (($164) - ($$1302))|0;
     $$3$ph = $202;$$3308$ph = $$2307;$$3312$ph = $199;$$3320$ph = $200;$$sink = $201;
     label = 58;
     continue;
    }
    else if ((label|0) == 58) {
     label = 0;
     $203 = HEAP8[$$sink>>0]|0;
     $$3 = $$3$ph;$$3316 = $$sink;$$sink471$sink = $203;
     L10: while(1) {
      $211 = $$sink471$sink&255;
      $212 = (3504 + ($211<<2)|0);
      $213 = HEAP32[$212>>2]|0;
      $indirectbr_cast = $213;
      switch ($indirectbr_cast|0) {
      case 6:  {
       break L1;
       break;
      }
      case 7:  {
       label = 61;
       break L7;
       break;
      }
      case 1:  {
       label = 6;
       break L10;
       break;
      }
      case 2:  {
       label = 37;
       break L10;
       break;
      }
      case 3:  {
       label = 39;
       break L10;
       break;
      }
      case 4:  {
       label = 41;
       break L10;
       break;
      }
      case 5:  {
       label = 42;
       break L10;
       break;
      }
      case 8:  {
       label = 10;
       break L10;
       break;
      }
      case 9:  {
       label = 12;
       break L10;
       break;
      }
      case 10:  {
       label = 8;
       break L10;
       break;
      }
      case 11:  {
       break;
      }
      default: {
       label = 65;
       break L7;
      }
      }
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $204 = ($$3>>>0)<(2);
      if ($204) {
       break L1;
      }
      $205 = ((($$3316)) + 1|0);
      $206 = (($$3) + -1)|0;
      $207 = HEAP8[$205>>0]|0;
      $$3 = $206;$$3316 = $205;$$sink471$sink = $207;
     }
     if ((label|0) == 6) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $27 = ($$sink471$sink&255) >>> 6;
      $28 = $27&255;
      $29 = (($28) + 2)|0;
      $30 = ($$3>>>0)>($29>>>0);
      if (!($30)) {
       break L1;
      }
      $31 = ($$sink471$sink&255) >>> 3;
      $32 = $31 & 7;
      $addconv334 = (($32) + 3)<<24>>24;
      $33 = $addconv334&255;
      $34 = $$sink471$sink & 7;
      $35 = $34&255;
      $36 = $35 << 8;
      $37 = ((($$3316)) + 1|0);
      $38 = HEAP8[$37>>0]|0;
      $39 = $38&255;
      $40 = $36 | $39;
      $$0297 = $$3;$$0299 = 2;$$0301 = $28;$$0303 = $33;$$0305 = $40;$$0309 = $$3312$ph;$$0313 = $$3316;$$0317 = $$3320$ph;
      label = 13;
      continue;
     }
     else if ((label|0) == 8) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $41 = ($$sink471$sink&255) >>> 3;
      $42 = $41 & 3;
      $43 = $42&255;
      $44 = (($43) + 3)|0;
      $45 = ($$3>>>0)>($44>>>0);
      if (!($45)) {
       break L1;
      }
      $46 = ((($$3316)) + 1|0);
      $$0$copyload$i332 = HEAPU8[$46>>0]|(HEAPU8[$46+1>>0]<<8);
      $47 = ($$sink471$sink << 2)&255;
      $48 = $47 & 28;
      $49 = $48&255;
      $50 = $$0$copyload$i332 & 3;
      $51 = $50&65535;
      $52 = $51 | $49;
      $53 = (($52) + 3)|0;
      $54 = ($$0$copyload$i332&65535) >>> 2;
      $55 = $54&65535;
      $$0297 = $$3;$$0299 = 3;$$0301 = $43;$$0303 = $53;$$0305 = $55;$$0309 = $$3312$ph;$$0313 = $$3316;$$0317 = $$3320$ph;
      label = 13;
      continue;
     }
     else if ((label|0) == 10) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $56 = ($$sink471$sink&255) >>> 6;
      $57 = $56&255;
      $58 = (($57) + 3)|0;
      $59 = ($$3>>>0)>($58>>>0);
      if (!($59)) {
       break L1;
      }
      $60 = ($$sink471$sink&255) >>> 3;
      $61 = $60 & 7;
      $addconv333 = (($61) + 3)<<24>>24;
      $62 = $addconv333&255;
      $63 = ((($$3316)) + 1|0);
      $$0$copyload$i330 = HEAPU8[$63>>0]|(HEAPU8[$63+1>>0]<<8);
      $64 = $$0$copyload$i330&65535;
      $$0297 = $$3;$$0299 = 3;$$0301 = $57;$$0303 = $62;$$0305 = $64;$$0309 = $$3312$ph;$$0313 = $$3316;$$0317 = $$3320$ph;
      label = 13;
      continue;
     }
     else if ((label|0) == 12) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $65 = ($$sink471$sink&255) >>> 6;
      $66 = $65&255;
      $67 = ($$sink471$sink&255) >>> 3;
      $68 = $67 & 7;
      $addconv = (($68) + 3)<<24>>24;
      $69 = $addconv&255;
      $70 = (($66) + 1)|0;
      $71 = ($$3>>>0)>($70>>>0);
      if ($71) {
       $$0297 = $$3;$$0299 = 1;$$0301 = $66;$$0303 = $69;$$0305 = $$3308$ph;$$0309 = $$3312$ph;$$0313 = $$3316;$$0317 = $$3320$ph;
       label = 13;
       continue;
      } else {
       break L1;
      }
     }
     else if ((label|0) == 37) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $142 = ($$3>>>0)<(2);
      if ($142) {
       break L1;
      }
      $143 = $$sink471$sink & 15;
      $144 = $143&255;
      $145 = ((($$3316)) + 1|0);
      $146 = (($$3) + -1)|0;
      $$1 = $146;$$1304 = $144;$$1306 = $$3308$ph;$$1310 = $$3312$ph;$$1314 = $145;$$1318 = $$3320$ph;
      label = 24;
      continue;
     }
     else if ((label|0) == 39) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $147 = ($$3>>>0)<(3);
      if ($147) {
       break L1;
      }
      $148 = ((($$3316)) + 1|0);
      $149 = HEAP8[$148>>0]|0;
      $150 = $149&255;
      $151 = (($150) + 16)|0;
      $152 = ((($$3316)) + 2|0);
      $153 = (($$3) + -2)|0;
      $$1 = $153;$$1304 = $151;$$1306 = $$3308$ph;$$1310 = $$3312$ph;$$1314 = $152;$$1318 = $$3320$ph;
      label = 24;
      continue;
     }
     else if ((label|0) == 41) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $154 = $$sink471$sink & 15;
      $155 = $154&255;
      $$1300 = 1;$$1302 = $155;$$2 = $$3;$$2307 = $$3308$ph;$$2311 = $$3312$ph;$$2315 = $$3316;$$2319 = $$3320$ph;
      label = 44;
      continue;
     }
     else if ((label|0) == 42) {
      label = 0;
      HEAP32[$0>>2] = $$3316;
      HEAP32[$8>>2] = $$3312$ph;
      HEAP32[$14>>2] = $$3308$ph;
      $156 = ($$3>>>0)<(3);
      if ($156) {
       break L1;
      }
      $157 = ((($$3316)) + 1|0);
      $158 = HEAP8[$157>>0]|0;
      $159 = $158&255;
      $160 = (($159) + 16)|0;
      $$1300 = 2;$$1302 = $160;$$2 = $$3;$$2307 = $$3308$ph;$$2311 = $$3312$ph;$$2315 = $$3316;$$2319 = $$3320$ph;
      label = 44;
      continue;
     }
    }
   }
   if ((label|0) == 19) {
    $83 = ($$0317|0)==(0);
    if (!($83)) {
     $$0295369 = 0;
     while(1) {
      $84 = (($72) + ($$0295369)|0);
      $85 = HEAP8[$84>>0]|0;
      $86 = (($$0309) + ($$0295369)|0);
      HEAP8[$86>>0] = $85;
      $87 = (($$0295369) + 1)|0;
      $exitcond413 = ($87|0)==($$0317|0);
      if ($exitcond413) {
       break;
      } else {
       $$0295369 = $87;
      }
     }
    }
    $88 = (($72) + ($$0317)|0);
    HEAP32[$0>>2] = $88;
    $89 = (($$0309) + ($$0317)|0);
    HEAP32[$8>>2] = $89;
    $90 = (($$0301) - ($$0317))|0;
    HEAP32[$15>>2] = $90;
    $91 = ((($0)) + 28|0);
    HEAP32[$91>>2] = $$0303;
    $92 = ((($0)) + 32|0);
    HEAP32[$92>>2] = $$0305;
    break;
   }
   else if ((label|0) == 32) {
    $130 = ($$1318|0)==(0);
    if (!($130)) {
     $$0292364 = 0;
     while(1) {
      $131 = (($$0292364) - ($$1306))|0;
      $132 = (($$1310) + ($131)|0);
      $133 = HEAP8[$132>>0]|0;
      $134 = (($$1310) + ($$0292364)|0);
      HEAP8[$134>>0] = $133;
      $135 = (($$0292364) + 1)|0;
      $exitcond = ($135|0)==($$1318|0);
      if ($exitcond) {
       break;
      } else {
       $$0292364 = $135;
      }
     }
    }
    HEAP32[$0>>2] = $$1314;
    $136 = (($$1310) + ($$1318)|0);
    HEAP32[$8>>2] = $136;
    HEAP32[$15>>2] = 0;
    $137 = (($$1304) - ($$1318))|0;
    $138 = ((($0)) + 28|0);
    HEAP32[$138>>2] = $137;
    $139 = ((($0)) + 32|0);
    HEAP32[$139>>2] = $$1306;
    break;
   }
   else if ((label|0) == 53) {
    $189 = ($$2319|0)==(0);
    if (!($189)) {
     $$0376 = 0;
     while(1) {
      $190 = (($163) + ($$0376)|0);
      $191 = HEAP8[$190>>0]|0;
      $192 = (($$2311) + ($$0376)|0);
      HEAP8[$192>>0] = $191;
      $193 = (($$0376) + 1)|0;
      $exitcond415 = ($193|0)==($$2319|0);
      if ($exitcond415) {
       break;
      } else {
       $$0376 = $193;
      }
     }
    }
    $194 = (($163) + ($$2319)|0);
    HEAP32[$0>>2] = $194;
    $195 = (($$2311) + ($$2319)|0);
    HEAP32[$8>>2] = $195;
    $196 = (($$1302) - ($$2319))|0;
    HEAP32[$15>>2] = $196;
    $197 = ((($0)) + 28|0);
    HEAP32[$197>>2] = 0;
    $198 = ((($0)) + 32|0);
    HEAP32[$198>>2] = $$2307;
    break;
   }
   else if ((label|0) == 61) {
    $208 = ($$3>>>0)<(8);
    if ($208) {
     break;
    }
    $209 = ((($$3316)) + 8|0);
    $210 = ((($0)) + 40|0);
    HEAP32[$210>>2] = 1;
    HEAP32[$0>>2] = $209;
    HEAP32[$8>>2] = $$3312$ph;
    HEAP32[$14>>2] = $$3308$ph;
    break;
   }
   else if ((label|0) == 65) {
    // unreachable;
   }
  }
 } while(0);
 return;
}
function _copy($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$0 = 0, $$08 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = (($0) + ($2)|0);
 $$0 = $0;$$08 = $1;
 while(1) {
  $4 = $$08;
  $5 = $4;
  $6 = HEAPU8[$5>>0]|(HEAPU8[$5+1>>0]<<8)|(HEAPU8[$5+2>>0]<<16)|(HEAPU8[$5+3>>0]<<24);
  $7 = (($4) + 4)|0;
  $8 = $7;
  $9 = HEAPU8[$8>>0]|(HEAPU8[$8+1>>0]<<8)|(HEAPU8[$8+2>>0]<<16)|(HEAPU8[$8+3>>0]<<24);
  $10 = $$0;
  $11 = $10;
  HEAP8[$11>>0]=$6&255;HEAP8[$11+1>>0]=($6>>8)&255;HEAP8[$11+2>>0]=($6>>16)&255;HEAP8[$11+3>>0]=$6>>24;
  $12 = (($10) + 4)|0;
  $13 = $12;
  HEAP8[$13>>0]=$9&255;HEAP8[$13+1>>0]=($9>>8)&255;HEAP8[$13+2>>0]=($9>>16)&255;HEAP8[$13+3>>0]=$9>>24;
  $14 = ((($$0)) + 8|0);
  $15 = ((($$08)) + 8|0);
  $16 = ($14>>>0)<($3>>>0);
  if ($16) {
   $$0 = $14;$$08 = $15;
  } else {
   break;
  }
 }
 return;
}
function _get_field($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$0 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = ($3|0)==(32);
 $5 = (_bitshift64Lshr(($0|0),($1|0),($2|0))|0);
 $6 = (getTempRet0() | 0);
 if ($4) {
  $$0 = $5;
 } else {
  $7 = 1 << $3;
  $8 = (($7) + -1)|0;
  $9 = $8 & $5;
  $$0 = $9;
 }
 return ($$0|0);
}
function _lzfse_decode_v1_freq_value($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $trunc12 = 0, $trunc12$clear = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = $0 & 31;
 $3 = (4672 + ($2)|0);
 $4 = HEAP8[$3>>0]|0;
 $5 = $4 << 24 >> 24;
 HEAP32[$1>>2] = $5;
 $trunc12 = $0&255;
 $trunc12$clear = $trunc12 & 15;
 switch ($trunc12$clear<<24>>24) {
 case 7:  {
  $6 = $0 >>> 4;
  $7 = $6 & 15;
  $8 = (($7) + 8)|0;
  $$0 = $8;
  break;
 }
 case 15:  {
  $9 = $0 >>> 4;
  $10 = $9 & 1023;
  $11 = (($10) + 24)|0;
  $$0 = $11;
  break;
 }
 default: {
  $12 = (4704 + ($2)|0);
  $13 = HEAP8[$12>>0]|0;
  $14 = $13 << 24 >> 24;
  $$0 = $14;
 }
 }
 return ($$0|0);
}
function _lzfse_decode_buffer($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$014 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $5 = ($4|0)==(0|0);
 if ($5) {
  $7 = (_malloc(47329)|0);
  $8 = ($7|0)==(0|0);
  if ($8) {
   $$014 = 0;
  } else {
   $9 = (_lzfse_decode_buffer_with_scratch($0,$1,$2,$3,$7)|0);
   _free($7);
   $$014 = $9;
  }
 } else {
  $6 = (_lzfse_decode_buffer_with_scratch($0,$1,$2,$3,$4)|0);
  $$014 = $6;
 }
 return ($$014|0);
}
function ___stdio_close($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $vararg_buffer = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $1 = ((($0)) + 60|0);
 $2 = HEAP32[$1>>2]|0;
 $3 = (_dummy($2)|0);
 HEAP32[$vararg_buffer>>2] = $3;
 $4 = (___syscall6(6,($vararg_buffer|0))|0);
 $5 = (___syscall_ret($4)|0);
 STACKTOP = sp;return ($5|0);
}
function ___stdio_write($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$052 = 0, $$053 = 0, $$055 = 0, $$057 = 0, $$1$ph = 0, $$154 = 0, $$158 = 0, $$pr = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0;
 var $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0;
 var $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 32|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(32|0);
 $3 = sp;
 $4 = sp + 16|0;
 $5 = ((($0)) + 28|0);
 $6 = HEAP32[$5>>2]|0;
 HEAP32[$3>>2] = $6;
 $7 = ((($3)) + 4|0);
 $8 = ((($0)) + 20|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = (($9) - ($6))|0;
 HEAP32[$7>>2] = $10;
 $11 = ((($3)) + 8|0);
 HEAP32[$11>>2] = $1;
 $12 = ((($3)) + 12|0);
 HEAP32[$12>>2] = $2;
 $13 = (($10) + ($2))|0;
 $14 = ((($0)) + 60|0);
 $$053 = 2;$$055 = $13;$$057 = $3;
 while(1) {
  $15 = HEAP32[$14>>2]|0;
  $16 = (___wasi_fd_write(($15|0),($$057|0),($$053|0),($4|0))|0);
  $17 = ($16<<16>>16)==(0);
  if ($17) {
   $$pr = HEAP32[$4>>2]|0;
   $19 = $$pr;
  } else {
   HEAP32[$4>>2] = -1;
   $19 = -1;
  }
  $18 = ($$055|0)==($19|0);
  if ($18) {
   label = 6;
   break;
  }
  $27 = ($19|0)<(0);
  if ($27) {
   label = 8;
   break;
  }
  $35 = (($$055) - ($19))|0;
  $36 = ((($$057)) + 4|0);
  $37 = HEAP32[$36>>2]|0;
  $38 = ($19>>>0)>($37>>>0);
  $39 = ((($$057)) + 8|0);
  $$158 = $38 ? $39 : $$057;
  $40 = $38 << 31 >> 31;
  $$154 = (($$053) + ($40))|0;
  $41 = $38 ? $37 : 0;
  $$052 = (($19) - ($41))|0;
  $42 = HEAP32[$$158>>2]|0;
  $43 = (($42) + ($$052)|0);
  HEAP32[$$158>>2] = $43;
  $44 = ((($$158)) + 4|0);
  $45 = HEAP32[$44>>2]|0;
  $46 = (($45) - ($$052))|0;
  HEAP32[$44>>2] = $46;
  $$053 = $$154;$$055 = $35;$$057 = $$158;
 }
 if ((label|0) == 6) {
  $20 = ((($0)) + 44|0);
  $21 = HEAP32[$20>>2]|0;
  $22 = ((($0)) + 48|0);
  $23 = HEAP32[$22>>2]|0;
  $24 = (($21) + ($23)|0);
  $25 = ((($0)) + 16|0);
  HEAP32[$25>>2] = $24;
  $26 = $21;
  HEAP32[$5>>2] = $26;
  HEAP32[$8>>2] = $26;
  $$1$ph = $2;
 }
 else if ((label|0) == 8) {
  $28 = ((($0)) + 16|0);
  HEAP32[$28>>2] = 0;
  HEAP32[$5>>2] = 0;
  HEAP32[$8>>2] = 0;
  $29 = HEAP32[$0>>2]|0;
  $30 = $29 | 32;
  HEAP32[$0>>2] = $30;
  $31 = ($$053|0)==(2);
  if ($31) {
   $$1$ph = 0;
  } else {
   $32 = ((($$057)) + 4|0);
   $33 = HEAP32[$32>>2]|0;
   $34 = (($2) - ($33))|0;
   $$1$ph = $34;
  }
 }
 STACKTOP = sp;return ($$1$ph|0);
}
function ___stdio_seek($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $vararg_buffer = 0;
 var $vararg_ptr1 = 0, $vararg_ptr2 = 0, $vararg_ptr3 = 0, $vararg_ptr4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 32|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(32|0);
 $vararg_buffer = sp + 8|0;
 $4 = sp;
 $5 = ((($0)) + 60|0);
 $6 = HEAP32[$5>>2]|0;
 $7 = $4;
 HEAP32[$vararg_buffer>>2] = $6;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $2;
 $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
 HEAP32[$vararg_ptr2>>2] = $1;
 $vararg_ptr3 = ((($vararg_buffer)) + 12|0);
 HEAP32[$vararg_ptr3>>2] = $7;
 $vararg_ptr4 = ((($vararg_buffer)) + 16|0);
 HEAP32[$vararg_ptr4>>2] = $3;
 $8 = (___syscall140(140,($vararg_buffer|0))|0);
 $9 = (___syscall_ret($8)|0);
 $10 = ($9|0)<(0);
 if ($10) {
  $17 = $4;
  $18 = $17;
  HEAP32[$18>>2] = -1;
  $19 = (($17) + 4)|0;
  $20 = $19;
  HEAP32[$20>>2] = -1;
  $21 = -1;$22 = -1;
 } else {
  $11 = $4;
  $12 = $11;
  $13 = HEAP32[$12>>2]|0;
  $14 = (($11) + 4)|0;
  $15 = $14;
  $16 = HEAP32[$15>>2]|0;
  $21 = $16;$22 = $13;
 }
 setTempRet0(($21) | 0);
 STACKTOP = sp;return ($22|0);
}
function ___syscall_ret($0) {
 $0 = $0|0;
 var $$0 = 0, $1 = 0, $2 = 0, $3 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ($0>>>0)>(4294963200);
 if ($1) {
  $2 = (0 - ($0))|0;
  $3 = (___errno_location()|0);
  HEAP32[$3>>2] = $2;
  $$0 = -1;
 } else {
  $$0 = $0;
 }
 return ($$0|0);
}
function ___errno_location() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 return (9312|0);
}
function _dummy($0) {
 $0 = $0|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return ($0|0);
}
function ___emscripten_stdout_close($0) {
 $0 = $0|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return 0;
}
function ___emscripten_stdout_seek($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 setTempRet0((0) | 0);
 return 0;
}
function _isdigit($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = (($0) + -48)|0;
 $2 = ($1>>>0)<(10);
 $3 = $2&1;
 return ($3|0);
}
function _pthread_self() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 return (7416|0);
}
function _strcmp($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$011 = 0, $$0710 = 0, $$lcssa = 0, $$lcssa8 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $or$cond = 0, $or$cond9 = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 $2 = HEAP8[$0>>0]|0;
 $3 = HEAP8[$1>>0]|0;
 $4 = ($2<<24>>24)!=($3<<24>>24);
 $5 = ($2<<24>>24)==(0);
 $or$cond9 = $5 | $4;
 if ($or$cond9) {
  $$lcssa = $3;$$lcssa8 = $2;
 } else {
  $$011 = $1;$$0710 = $0;
  while(1) {
   $6 = ((($$0710)) + 1|0);
   $7 = ((($$011)) + 1|0);
   $8 = HEAP8[$6>>0]|0;
   $9 = HEAP8[$7>>0]|0;
   $10 = ($8<<24>>24)!=($9<<24>>24);
   $11 = ($8<<24>>24)==(0);
   $or$cond = $11 | $10;
   if ($or$cond) {
    $$lcssa = $9;$$lcssa8 = $8;
    break;
   } else {
    $$011 = $7;$$0710 = $6;
   }
  }
 }
 $12 = $$lcssa8&255;
 $13 = $$lcssa&255;
 $14 = (($12) - ($13))|0;
 return ($14|0);
}
function _strlen($0) {
 $0 = $0|0;
 var $$0 = 0, $$014 = 0, $$015$lcssa = 0, $$01518 = 0, $$1$lcssa = 0, $$pn = 0, $$pn29 = 0, $$pre = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0;
 var $20 = 0, $21 = 0, $22 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = $0;
 $2 = $1 & 3;
 $3 = ($2|0)==(0);
 L1: do {
  if ($3) {
   $$015$lcssa = $0;
   label = 5;
  } else {
   $$01518 = $0;$22 = $1;
   while(1) {
    $4 = HEAP8[$$01518>>0]|0;
    $5 = ($4<<24>>24)==(0);
    if ($5) {
     $$pn = $22;
     break L1;
    }
    $6 = ((($$01518)) + 1|0);
    $7 = $6;
    $8 = $7 & 3;
    $9 = ($8|0)==(0);
    if ($9) {
     $$015$lcssa = $6;
     label = 5;
     break;
    } else {
     $$01518 = $6;$22 = $7;
    }
   }
  }
 } while(0);
 if ((label|0) == 5) {
  $$0 = $$015$lcssa;
  while(1) {
   $10 = HEAP32[$$0>>2]|0;
   $11 = (($10) + -16843009)|0;
   $12 = $10 & -2139062144;
   $13 = $12 ^ -2139062144;
   $14 = $13 & $11;
   $15 = ($14|0)==(0);
   $16 = ((($$0)) + 4|0);
   if ($15) {
    $$0 = $16;
   } else {
    break;
   }
  }
  $17 = $10&255;
  $18 = ($17<<24>>24)==(0);
  if ($18) {
   $$1$lcssa = $$0;
  } else {
   $$pn29 = $$0;
   while(1) {
    $19 = ((($$pn29)) + 1|0);
    $$pre = HEAP8[$19>>0]|0;
    $20 = ($$pre<<24>>24)==(0);
    if ($20) {
     $$1$lcssa = $19;
     break;
    } else {
     $$pn29 = $19;
    }
   }
  }
  $21 = $$1$lcssa;
  $$pn = $21;
 }
 $$014 = (($$pn) - ($1))|0;
 return ($$014|0);
}
function _fwrite($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $phitmp = 0, $spec$select = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = Math_imul($2, $1)|0;
 $5 = ($1|0)==(0);
 $spec$select = $5 ? 0 : $2;
 $6 = ((($3)) + 76|0);
 $7 = HEAP32[$6>>2]|0;
 $8 = ($7|0)>(-1);
 if ($8) {
  $10 = (___lockfile($3)|0);
  $phitmp = ($10|0)==(0);
  $11 = (___fwritex($0,$4,$3)|0);
  if ($phitmp) {
   $13 = $11;
  } else {
   ___unlockfile($3);
   $13 = $11;
  }
 } else {
  $9 = (___fwritex($0,$4,$3)|0);
  $13 = $9;
 }
 $12 = ($13|0)==($4|0);
 if ($12) {
  $15 = $spec$select;
 } else {
  $14 = (($13>>>0) / ($1>>>0))&-1;
  $15 = $14;
 }
 return ($15|0);
}
function ___unlockfile($0) {
 $0 = $0|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return;
}
function ___lockfile($0) {
 $0 = $0|0;
 var label = 0, sp = 0;
 sp = STACKTOP;
 return 1;
}
function ___overflow($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $$pre = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $3 = 0, $4 = 0;
 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $2 = sp;
 $3 = $1&255;
 HEAP8[$2>>0] = $3;
 $4 = ((($0)) + 16|0);
 $5 = HEAP32[$4>>2]|0;
 $6 = ($5|0)==(0|0);
 if ($6) {
  $7 = (___towrite($0)|0);
  $8 = ($7|0)==(0);
  if ($8) {
   $$pre = HEAP32[$4>>2]|0;
   $12 = $$pre;
   label = 4;
  } else {
   $$0 = -1;
  }
 } else {
  $12 = $5;
  label = 4;
 }
 do {
  if ((label|0) == 4) {
   $9 = ((($0)) + 20|0);
   $10 = HEAP32[$9>>2]|0;
   $11 = ($10>>>0)<($12>>>0);
   if ($11) {
    $13 = $1 & 255;
    $14 = ((($0)) + 75|0);
    $15 = HEAP8[$14>>0]|0;
    $16 = $15 << 24 >> 24;
    $17 = ($13|0)==($16|0);
    if (!($17)) {
     $18 = ((($10)) + 1|0);
     HEAP32[$9>>2] = $18;
     HEAP8[$10>>0] = $3;
     $$0 = $13;
     break;
    }
   }
   $19 = ((($0)) + 36|0);
   $20 = HEAP32[$19>>2]|0;
   $21 = (FUNCTION_TABLE_iiii[$20 & 3]($0,$2,1)|0);
   $22 = ($21|0)==(1);
   if ($22) {
    $23 = HEAP8[$2>>0]|0;
    $24 = $23&255;
    $$0 = $24;
   } else {
    $$0 = -1;
   }
  }
 } while(0);
 STACKTOP = sp;return ($$0|0);
}
function ___towrite($0) {
 $0 = $0|0;
 var $$0 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
 var $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 74|0);
 $2 = HEAP8[$1>>0]|0;
 $3 = $2 << 24 >> 24;
 $4 = (($3) + 255)|0;
 $5 = $4 | $3;
 $6 = $5&255;
 HEAP8[$1>>0] = $6;
 $7 = HEAP32[$0>>2]|0;
 $8 = $7 & 8;
 $9 = ($8|0)==(0);
 if ($9) {
  $11 = ((($0)) + 8|0);
  HEAP32[$11>>2] = 0;
  $12 = ((($0)) + 4|0);
  HEAP32[$12>>2] = 0;
  $13 = ((($0)) + 44|0);
  $14 = HEAP32[$13>>2]|0;
  $15 = ((($0)) + 28|0);
  HEAP32[$15>>2] = $14;
  $16 = ((($0)) + 20|0);
  HEAP32[$16>>2] = $14;
  $17 = $14;
  $18 = ((($0)) + 48|0);
  $19 = HEAP32[$18>>2]|0;
  $20 = (($17) + ($19)|0);
  $21 = ((($0)) + 16|0);
  HEAP32[$21>>2] = $20;
  $$0 = 0;
 } else {
  $10 = $7 | 32;
  HEAP32[$0>>2] = $10;
  $$0 = -1;
 }
 return ($$0|0);
}
function ___fwritex($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$03846 = 0, $$042 = 0, $$1 = 0, $$139 = 0, $$141 = 0, $$143 = 0, $$pre = 0, $$pre48 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0;
 var $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
 var $9 = 0, $or$cond = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ((($2)) + 16|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = ($4|0)==(0|0);
 if ($5) {
  $7 = (___towrite($2)|0);
  $8 = ($7|0)==(0);
  if ($8) {
   $$pre = HEAP32[$3>>2]|0;
   $12 = $$pre;
   label = 5;
  } else {
   $$1 = 0;
  }
 } else {
  $6 = $4;
  $12 = $6;
  label = 5;
 }
 L5: do {
  if ((label|0) == 5) {
   $9 = ((($2)) + 20|0);
   $10 = HEAP32[$9>>2]|0;
   $11 = (($12) - ($10))|0;
   $13 = ($11>>>0)<($1>>>0);
   $14 = $10;
   if ($13) {
    $15 = ((($2)) + 36|0);
    $16 = HEAP32[$15>>2]|0;
    $17 = (FUNCTION_TABLE_iiii[$16 & 3]($2,$0,$1)|0);
    $$1 = $17;
    break;
   }
   $18 = ((($2)) + 75|0);
   $19 = HEAP8[$18>>0]|0;
   $20 = ($19<<24>>24)<(0);
   $21 = ($1|0)==(0);
   $or$cond = $20 | $21;
   L10: do {
    if ($or$cond) {
     $$139 = 0;$$141 = $0;$$143 = $1;$32 = $14;
    } else {
     $$03846 = $1;
     while(1) {
      $23 = (($$03846) + -1)|0;
      $24 = (($0) + ($23)|0);
      $25 = HEAP8[$24>>0]|0;
      $26 = ($25<<24>>24)==(10);
      if ($26) {
       break;
      }
      $22 = ($23|0)==(0);
      if ($22) {
       $$139 = 0;$$141 = $0;$$143 = $1;$32 = $14;
       break L10;
      } else {
       $$03846 = $23;
      }
     }
     $27 = ((($2)) + 36|0);
     $28 = HEAP32[$27>>2]|0;
     $29 = (FUNCTION_TABLE_iiii[$28 & 3]($2,$0,$$03846)|0);
     $30 = ($29>>>0)<($$03846>>>0);
     if ($30) {
      $$1 = $29;
      break L5;
     }
     $31 = (($0) + ($$03846)|0);
     $$042 = (($1) - ($$03846))|0;
     $$pre48 = HEAP32[$9>>2]|0;
     $$139 = $$03846;$$141 = $31;$$143 = $$042;$32 = $$pre48;
    }
   } while(0);
   (_memcpy(($32|0),($$141|0),($$143|0))|0);
   $33 = HEAP32[$9>>2]|0;
   $34 = (($33) + ($$143)|0);
   HEAP32[$9>>2] = $34;
   $35 = (($$139) + ($$143))|0;
   $$1 = $35;
  }
 } while(0);
 return ($$1|0);
}
function ___lctrans_impl($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($1|0)==(0|0);
 if ($2) {
  $$0 = 0;
 } else {
  $3 = HEAP32[$1>>2]|0;
  $4 = ((($1)) + 4|0);
  $5 = HEAP32[$4>>2]|0;
  $6 = (___mo_lookup($3,$5,$0)|0);
  $$0 = $6;
 }
 $7 = ($$0|0)==(0|0);
 $8 = $7 ? $0 : $$0;
 return ($8|0);
}
function ___mo_lookup($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$090 = 0, $$094 = 0, $$191 = 0, $$195 = 0, $$4 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0;
 var $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0;
 var $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0;
 var $61 = 0, $62 = 0, $63 = 0, $64 = 0, $7 = 0, $8 = 0, $9 = 0, $or$cond = 0, $or$cond102 = 0, $or$cond104 = 0, $spec$select = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = HEAP32[$0>>2]|0;
 $4 = (($3) + 1794895138)|0;
 $5 = ((($0)) + 8|0);
 $6 = HEAP32[$5>>2]|0;
 $7 = (_swapc($6,$4)|0);
 $8 = ((($0)) + 12|0);
 $9 = HEAP32[$8>>2]|0;
 $10 = (_swapc($9,$4)|0);
 $11 = ((($0)) + 16|0);
 $12 = HEAP32[$11>>2]|0;
 $13 = (_swapc($12,$4)|0);
 $14 = $1 >>> 2;
 $15 = ($7>>>0)<($14>>>0);
 L1: do {
  if ($15) {
   $16 = $7 << 2;
   $17 = (($1) - ($16))|0;
   $18 = ($10>>>0)<($17>>>0);
   $19 = ($13>>>0)<($17>>>0);
   $or$cond = $18 & $19;
   if ($or$cond) {
    $20 = $13 | $10;
    $21 = $20 & 3;
    $22 = ($21|0)==(0);
    if ($22) {
     $23 = $10 >>> 2;
     $24 = $13 >>> 2;
     $$090 = 0;$$094 = $7;
     while(1) {
      $25 = $$094 >>> 1;
      $26 = (($$090) + ($25))|0;
      $27 = $26 << 1;
      $28 = (($27) + ($23))|0;
      $29 = (($0) + ($28<<2)|0);
      $30 = HEAP32[$29>>2]|0;
      $31 = (_swapc($30,$4)|0);
      $32 = (($28) + 1)|0;
      $33 = (($0) + ($32<<2)|0);
      $34 = HEAP32[$33>>2]|0;
      $35 = (_swapc($34,$4)|0);
      $36 = ($35>>>0)<($1>>>0);
      $37 = (($1) - ($35))|0;
      $38 = ($31>>>0)<($37>>>0);
      $or$cond102 = $36 & $38;
      if (!($or$cond102)) {
       $$4 = 0;
       break L1;
      }
      $39 = (($35) + ($31))|0;
      $40 = (($0) + ($39)|0);
      $41 = HEAP8[$40>>0]|0;
      $42 = ($41<<24>>24)==(0);
      if (!($42)) {
       $$4 = 0;
       break L1;
      }
      $43 = (($0) + ($35)|0);
      $44 = (_strcmp($2,$43)|0);
      $45 = ($44|0)==(0);
      if ($45) {
       break;
      }
      $62 = ($$094|0)==(1);
      $63 = ($44|0)<(0);
      if ($62) {
       $$4 = 0;
       break L1;
      }
      $$191 = $63 ? $$090 : $26;
      $64 = (($$094) - ($25))|0;
      $$195 = $63 ? $25 : $64;
      $$090 = $$191;$$094 = $$195;
     }
     $46 = (($27) + ($24))|0;
     $47 = (($0) + ($46<<2)|0);
     $48 = HEAP32[$47>>2]|0;
     $49 = (_swapc($48,$4)|0);
     $50 = (($46) + 1)|0;
     $51 = (($0) + ($50<<2)|0);
     $52 = HEAP32[$51>>2]|0;
     $53 = (_swapc($52,$4)|0);
     $54 = ($53>>>0)<($1>>>0);
     $55 = (($1) - ($53))|0;
     $56 = ($49>>>0)<($55>>>0);
     $or$cond104 = $54 & $56;
     if ($or$cond104) {
      $57 = (($0) + ($53)|0);
      $58 = (($53) + ($49))|0;
      $59 = (($0) + ($58)|0);
      $60 = HEAP8[$59>>0]|0;
      $61 = ($60<<24>>24)==(0);
      $spec$select = $61 ? $57 : 0;
      $$4 = $spec$select;
     } else {
      $$4 = 0;
     }
    } else {
     $$4 = 0;
    }
   } else {
    $$4 = 0;
   }
  } else {
   $$4 = 0;
  }
 } while(0);
 return ($$4|0);
}
function _swapc($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $spec$select = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($1|0)==(0);
 $3 = (_llvm_bswap_i32(($0|0))|0);
 $spec$select = $2 ? $0 : $3;
 return ($spec$select|0);
}
function ___ofl_lock() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 ___lock((9316|0));
 return (9324|0);
}
function ___ofl_unlock() {
 var label = 0, sp = 0;
 sp = STACKTOP;
 ___unlock((9316|0));
 return;
}
function _fflush($0) {
 $0 = $0|0;
 var $$0 = 0, $$023 = 0, $$02325 = 0, $$02327 = 0, $$024$lcssa = 0, $$02426 = 0, $$1 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0;
 var $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $phitmp = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ($0|0)==(0|0);
 do {
  if ($1) {
   $8 = HEAP32[1853]|0;
   $9 = ($8|0)==(0|0);
   if ($9) {
    $29 = 0;
   } else {
    $10 = HEAP32[1853]|0;
    $11 = (_fflush($10)|0);
    $29 = $11;
   }
   $12 = (___ofl_lock()|0);
   $$02325 = HEAP32[$12>>2]|0;
   $13 = ($$02325|0)==(0|0);
   if ($13) {
    $$024$lcssa = $29;
   } else {
    $$02327 = $$02325;$$02426 = $29;
    while(1) {
     $14 = ((($$02327)) + 76|0);
     $15 = HEAP32[$14>>2]|0;
     $16 = ($15|0)>(-1);
     if ($16) {
      $17 = (___lockfile($$02327)|0);
      $26 = $17;
     } else {
      $26 = 0;
     }
     $18 = ((($$02327)) + 20|0);
     $19 = HEAP32[$18>>2]|0;
     $20 = ((($$02327)) + 28|0);
     $21 = HEAP32[$20>>2]|0;
     $22 = ($19>>>0)>($21>>>0);
     if ($22) {
      $23 = (___fflush_unlocked($$02327)|0);
      $24 = $23 | $$02426;
      $$1 = $24;
     } else {
      $$1 = $$02426;
     }
     $25 = ($26|0)==(0);
     if (!($25)) {
      ___unlockfile($$02327);
     }
     $27 = ((($$02327)) + 56|0);
     $$023 = HEAP32[$27>>2]|0;
     $28 = ($$023|0)==(0|0);
     if ($28) {
      $$024$lcssa = $$1;
      break;
     } else {
      $$02327 = $$023;$$02426 = $$1;
     }
    }
   }
   ___ofl_unlock();
   $$0 = $$024$lcssa;
  } else {
   $2 = ((($0)) + 76|0);
   $3 = HEAP32[$2>>2]|0;
   $4 = ($3|0)>(-1);
   if (!($4)) {
    $5 = (___fflush_unlocked($0)|0);
    $$0 = $5;
    break;
   }
   $6 = (___lockfile($0)|0);
   $phitmp = ($6|0)==(0);
   $7 = (___fflush_unlocked($0)|0);
   if ($phitmp) {
    $$0 = $7;
   } else {
    ___unlockfile($0);
    $$0 = $7;
   }
  }
 } while(0);
 return ($$0|0);
}
function ___fflush_unlocked($0) {
 $0 = $0|0;
 var $$0 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $3 = 0, $4 = 0, $5 = 0;
 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ((($0)) + 20|0);
 $2 = HEAP32[$1>>2]|0;
 $3 = ((($0)) + 28|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = ($2>>>0)>($4>>>0);
 if ($5) {
  $6 = ((($0)) + 36|0);
  $7 = HEAP32[$6>>2]|0;
  (FUNCTION_TABLE_iiii[$7 & 3]($0,0,0)|0);
  $8 = HEAP32[$1>>2]|0;
  $9 = ($8|0)==(0|0);
  if ($9) {
   $$0 = -1;
  } else {
   label = 3;
  }
 } else {
  label = 3;
 }
 if ((label|0) == 3) {
  $10 = ((($0)) + 4|0);
  $11 = HEAP32[$10>>2]|0;
  $12 = ((($0)) + 8|0);
  $13 = HEAP32[$12>>2]|0;
  $14 = ($11>>>0)<($13>>>0);
  if ($14) {
   $15 = $11;
   $16 = $13;
   $17 = (($15) - ($16))|0;
   $18 = ($17|0)<(0);
   $19 = $18 << 31 >> 31;
   $20 = ((($0)) + 40|0);
   $21 = HEAP32[$20>>2]|0;
   (FUNCTION_TABLE_iiiii[$21 & 7]($0,$17,$19,1)|0);
   $22 = (getTempRet0() | 0);
  }
  $23 = ((($0)) + 16|0);
  HEAP32[$23>>2] = 0;
  HEAP32[$3>>2] = 0;
  HEAP32[$1>>2] = 0;
  HEAP32[$12>>2] = 0;
  HEAP32[$10>>2] = 0;
  $$0 = 0;
 }
 return ($$0|0);
}
function _memchr($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$0$lcssa = 0, $$035$lcssa = 0, $$035$lcssa65 = 0, $$03555 = 0, $$036$lcssa = 0, $$036$lcssa64 = 0, $$03654 = 0, $$046 = 0, $$137$lcssa = 0, $$137$lcssa66 = 0, $$13745 = 0, $$140 = 0, $$23839 = 0, $$in = 0, $$lcssa = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0;
 var $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0;
 var $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $or$cond = 0, $or$cond53 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = $1 & 255;
 $4 = $0;
 $5 = $4 & 3;
 $6 = ($5|0)!=(0);
 $7 = ($2|0)!=(0);
 $or$cond53 = $7 & $6;
 L1: do {
  if ($or$cond53) {
   $8 = $1&255;
   $$03555 = $0;$$03654 = $2;
   while(1) {
    $9 = HEAP8[$$03555>>0]|0;
    $10 = ($9<<24>>24)==($8<<24>>24);
    if ($10) {
     $$035$lcssa65 = $$03555;$$036$lcssa64 = $$03654;
     label = 6;
     break L1;
    }
    $11 = ((($$03555)) + 1|0);
    $12 = (($$03654) + -1)|0;
    $13 = $11;
    $14 = $13 & 3;
    $15 = ($14|0)!=(0);
    $16 = ($12|0)!=(0);
    $or$cond = $16 & $15;
    if ($or$cond) {
     $$03555 = $11;$$03654 = $12;
    } else {
     $$035$lcssa = $11;$$036$lcssa = $12;$$lcssa = $16;
     label = 5;
     break;
    }
   }
  } else {
   $$035$lcssa = $0;$$036$lcssa = $2;$$lcssa = $7;
   label = 5;
  }
 } while(0);
 if ((label|0) == 5) {
  if ($$lcssa) {
   $$035$lcssa65 = $$035$lcssa;$$036$lcssa64 = $$036$lcssa;
   label = 6;
  } else {
   label = 16;
  }
 }
 L8: do {
  if ((label|0) == 6) {
   $17 = HEAP8[$$035$lcssa65>>0]|0;
   $18 = $1&255;
   $19 = ($17<<24>>24)==($18<<24>>24);
   if ($19) {
    $38 = ($$036$lcssa64|0)==(0);
    if ($38) {
     label = 16;
     break;
    } else {
     $39 = $$035$lcssa65;
     break;
    }
   }
   $20 = Math_imul($3, 16843009)|0;
   $21 = ($$036$lcssa64>>>0)>(3);
   L13: do {
    if ($21) {
     $$046 = $$035$lcssa65;$$13745 = $$036$lcssa64;
     while(1) {
      $22 = HEAP32[$$046>>2]|0;
      $23 = $22 ^ $20;
      $24 = (($23) + -16843009)|0;
      $25 = $23 & -2139062144;
      $26 = $25 ^ -2139062144;
      $27 = $26 & $24;
      $28 = ($27|0)==(0);
      if (!($28)) {
       $$137$lcssa66 = $$13745;$$in = $$046;
       break L13;
      }
      $29 = ((($$046)) + 4|0);
      $30 = (($$13745) + -4)|0;
      $31 = ($30>>>0)>(3);
      if ($31) {
       $$046 = $29;$$13745 = $30;
      } else {
       $$0$lcssa = $29;$$137$lcssa = $30;
       label = 11;
       break;
      }
     }
    } else {
     $$0$lcssa = $$035$lcssa65;$$137$lcssa = $$036$lcssa64;
     label = 11;
    }
   } while(0);
   if ((label|0) == 11) {
    $32 = ($$137$lcssa|0)==(0);
    if ($32) {
     label = 16;
     break;
    } else {
     $$137$lcssa66 = $$137$lcssa;$$in = $$0$lcssa;
    }
   }
   $$140 = $$in;$$23839 = $$137$lcssa66;
   while(1) {
    $33 = HEAP8[$$140>>0]|0;
    $34 = ($33<<24>>24)==($18<<24>>24);
    if ($34) {
     $39 = $$140;
     break L8;
    }
    $35 = ((($$140)) + 1|0);
    $36 = (($$23839) + -1)|0;
    $37 = ($36|0)==(0);
    if ($37) {
     label = 16;
     break;
    } else {
     $$140 = $35;$$23839 = $36;
    }
   }
  }
 } while(0);
 if ((label|0) == 16) {
  $39 = 0;
 }
 return ($39|0);
}
function _fprintf($0,$1,$varargs) {
 $0 = $0|0;
 $1 = $1|0;
 $varargs = $varargs|0;
 var $2 = 0, $3 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $2 = sp;
 HEAP32[$2>>2] = $varargs;
 $3 = (_vfprintf($0,$1,$2)|0);
 STACKTOP = sp;return ($3|0);
}
function _vfprintf($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $3 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = (___vfprintf_internal($0,$1,$2,6,7)|0);
 return ($3|0);
}
function _fmt_fp($0,$1,$2,$3,$4,$5) {
 $0 = $0|0;
 $1 = +$1;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 var $$ = 0, $$0 = 0, $$0463$lcssa = 0, $$0463588 = 0, $$0464599 = 0, $$0471 = 0.0, $$0479 = 0, $$0487657 = 0, $$0488 = 0, $$0488669 = 0, $$0488671 = 0, $$0497670 = 0, $$0498 = 0, $$0511586 = 0.0, $$0512 = 0, $$0513 = 0, $$0516652 = 0, $$0522 = 0, $$0523 = 0, $$0525 = 0;
 var $$0527 = 0, $$0529 = 0, $$0529$in646 = 0, $$0532651 = 0, $$1465 = 0, $$1467 = 0.0, $$1469 = 0.0, $$1472 = 0.0, $$1480 = 0, $$1482$lcssa = 0, $$1482683 = 0, $$1489656 = 0, $$1499 = 0, $$1510587 = 0, $$1514$lcssa = 0, $$1514614 = 0, $$1517 = 0, $$1526 = 0, $$1528 = 0, $$1530621 = 0;
 var $$1533$lcssa = 0, $$1533645 = 0, $$1604 = 0, $$2 = 0, $$2473 = 0.0, $$2476 = 0, $$2483 = 0, $$2490$lcssa = 0, $$2490638 = 0, $$2500$lcssa = 0, $$2500682 = 0, $$2515 = 0, $$2518634 = 0, $$2531 = 0, $$2534633 = 0, $$3 = 0.0, $$3477 = 0, $$3484$lcssa = 0, $$3484663 = 0, $$3501$lcssa = 0;
 var $$3501676 = 0, $$3535620 = 0, $$4 = 0.0, $$4478$lcssa = 0, $$4478594 = 0, $$4492 = 0, $$4502$lcssa = 0, $$4502662 = 0, $$4520 = 0, $$5$lcssa = 0, $$5486$lcssa = 0, $$5486639 = 0, $$5493603 = 0, $$5503 = 0, $$5521 = 0, $$560 = 0, $$5609 = 0, $$6 = 0, $$6494593 = 0, $$7495608 = 0;
 var $$8 = 0, $$8506 = 0, $$9 = 0, $$9507$lcssa = 0, $$9507625 = 0, $$lcssa583 = 0, $$lobit = 0, $$neg = 0, $$neg571 = 0, $$not = 0, $$pn = 0, $$pr = 0, $$pr564 = 0, $$pre = 0, $$pre$phi717Z2D = 0, $$pre$phi718Z2D = 0, $$pre720 = 0, $$sink757 = 0, $10 = 0, $100 = 0;
 var $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0;
 var $12 = 0, $120 = 0, $121 = 0.0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0.0, $129 = 0.0, $13 = 0, $130 = 0.0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0;
 var $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0.0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0;
 var $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0, $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0;
 var $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0, $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0, $19 = 0, $190 = 0, $191 = 0;
 var $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0, $198 = 0, $199 = 0, $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0, $208 = 0, $209 = 0, $21 = 0;
 var $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0, $215 = 0, $216 = 0, $217 = 0, $218 = 0, $219 = 0, $22 = 0, $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0, $226 = 0, $227 = 0, $228 = 0;
 var $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0, $233 = 0, $234 = 0, $235 = 0, $236 = 0, $237 = 0, $238 = 0, $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0, $244 = 0, $245 = 0, $246 = 0.0;
 var $247 = 0.0, $248 = 0, $249 = 0.0, $25 = 0, $250 = 0, $251 = 0, $252 = 0, $253 = 0, $254 = 0, $255 = 0, $256 = 0, $257 = 0, $258 = 0, $259 = 0, $26 = 0, $260 = 0, $261 = 0, $262 = 0, $263 = 0, $264 = 0;
 var $265 = 0, $266 = 0, $267 = 0, $268 = 0, $269 = 0, $27 = 0, $270 = 0, $271 = 0, $272 = 0, $273 = 0, $274 = 0, $275 = 0, $276 = 0, $277 = 0, $278 = 0, $279 = 0, $28 = 0, $280 = 0, $281 = 0, $282 = 0;
 var $283 = 0, $284 = 0, $285 = 0, $286 = 0, $287 = 0, $288 = 0, $289 = 0, $29 = 0, $290 = 0, $291 = 0, $292 = 0, $293 = 0, $294 = 0, $295 = 0, $296 = 0, $297 = 0, $298 = 0, $299 = 0, $30 = 0, $300 = 0;
 var $301 = 0, $302 = 0, $303 = 0, $304 = 0, $305 = 0, $306 = 0, $307 = 0, $308 = 0, $309 = 0, $31 = 0, $310 = 0, $311 = 0, $312 = 0, $313 = 0, $314 = 0, $315 = 0, $316 = 0, $317 = 0, $318 = 0, $319 = 0;
 var $32 = 0, $320 = 0, $321 = 0, $322 = 0, $323 = 0, $324 = 0, $325 = 0, $326 = 0, $327 = 0, $328 = 0, $329 = 0, $33 = 0, $330 = 0, $331 = 0, $332 = 0, $333 = 0, $334 = 0, $335 = 0, $336 = 0, $337 = 0;
 var $338 = 0, $339 = 0, $34 = 0, $340 = 0, $341 = 0, $342 = 0, $343 = 0, $344 = 0, $345 = 0, $346 = 0, $347 = 0, $348 = 0, $349 = 0, $35 = 0, $350 = 0, $351 = 0, $352 = 0, $353 = 0, $354 = 0, $355 = 0;
 var $356 = 0, $357 = 0, $358 = 0, $359 = 0, $36 = 0, $360 = 0, $361 = 0, $362 = 0, $363 = 0, $364 = 0, $365 = 0, $366 = 0, $367 = 0, $368 = 0, $369 = 0, $37 = 0.0, $370 = 0, $371 = 0, $372 = 0, $373 = 0;
 var $374 = 0, $375 = 0, $376 = 0, $377 = 0, $378 = 0, $379 = 0, $38 = 0.0, $380 = 0, $381 = 0, $382 = 0, $383 = 0, $384 = 0, $385 = 0, $386 = 0, $387 = 0, $388 = 0, $389 = 0, $39 = 0, $390 = 0, $391 = 0;
 var $392 = 0, $393 = 0, $394 = 0, $395 = 0, $396 = 0, $397 = 0, $398 = 0, $399 = 0, $40 = 0, $400 = 0, $401 = 0, $402 = 0, $403 = 0, $404 = 0, $405 = 0, $406 = 0, $407 = 0, $408 = 0, $409 = 0, $41 = 0;
 var $410 = 0, $411 = 0, $412 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0.0, $54 = 0, $55 = 0, $56 = 0, $57 = 0.0, $58 = 0.0;
 var $59 = 0.0, $6 = 0, $60 = 0.0, $61 = 0.0, $62 = 0.0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0;
 var $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0.0, $91 = 0.0, $92 = 0.0, $93 = 0, $94 = 0;
 var $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $not$ = 0, $or$cond = 0, $or$cond3$not = 0, $or$cond543 = 0, $or$cond546 = 0, $or$cond556 = 0, $or$cond559 = 0, $or$cond6 = 0, $scevgep711 = 0, $scevgep711712 = 0, $spec$select = 0, $spec$select539 = 0, $spec$select540 = 0, $spec$select540722 = 0, $spec$select540723 = 0;
 var $spec$select541 = 0, $spec$select544 = 0.0, $spec$select547 = 0, $spec$select548 = 0, $spec$select549 = 0, $spec$select551 = 0, $spec$select554 = 0, $spec$select557 = 0, $spec$select561 = 0.0, $spec$select562 = 0, $spec$select563 = 0, $spec$select565 = 0, $spec$select566 = 0, $spec$select567 = 0.0, $spec$select568 = 0.0, $spec$select569 = 0.0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 560|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(560|0);
 $6 = sp + 32|0;
 $7 = sp + 536|0;
 $8 = sp;
 $9 = $8;
 $10 = sp + 540|0;
 HEAP32[$7>>2] = 0;
 $11 = ((($10)) + 12|0);
 $12 = (___DOUBLE_BITS_662($1)|0);
 $13 = (getTempRet0() | 0);
 $14 = ($13|0)<(0);
 if ($14) {
  $15 = - $1;
  $16 = (___DOUBLE_BITS_662($15)|0);
  $17 = (getTempRet0() | 0);
  $$0471 = $15;$$0522 = 1;$$0523 = 8149;$25 = $17;$412 = $16;
 } else {
  $18 = $4 & 2048;
  $19 = ($18|0)==(0);
  $20 = $4 & 1;
  $21 = ($20|0)==(0);
  $$ = $21 ? (8150) : (8155);
  $spec$select565 = $19 ? $$ : (8152);
  $22 = $4 & 2049;
  $23 = ($22|0)!=(0);
  $spec$select566 = $23&1;
  $$0471 = $1;$$0522 = $spec$select566;$$0523 = $spec$select565;$25 = $13;$412 = $12;
 }
 $24 = $25 & 2146435072;
 $26 = (0)==(0);
 $27 = ($24|0)==(2146435072);
 $28 = $26 & $27;
 do {
  if ($28) {
   $29 = $5 & 32;
   $30 = ($29|0)!=(0);
   $31 = $30 ? 8168 : 8172;
   $32 = ($$0471 != $$0471) | (0.0 != 0.0);
   $33 = $30 ? 8176 : 8180;
   $$0512 = $32 ? $33 : $31;
   $34 = (($$0522) + 3)|0;
   $35 = $4 & -65537;
   _pad_659($0,32,$2,$34,$35);
   _out_653($0,$$0523,$$0522);
   _out_653($0,$$0512,3);
   $36 = $4 ^ 8192;
   _pad_659($0,32,$2,$34,$36);
   $$sink757 = $34;
  } else {
   $37 = (+_frexp($$0471,$7));
   $38 = $37 * 2.0;
   $39 = $38 != 0.0;
   if ($39) {
    $40 = HEAP32[$7>>2]|0;
    $41 = (($40) + -1)|0;
    HEAP32[$7>>2] = $41;
   }
   $42 = $5 | 32;
   $43 = ($42|0)==(97);
   if ($43) {
    $44 = $5 & 32;
    $45 = ($44|0)==(0);
    $46 = ((($$0523)) + 9|0);
    $spec$select = $45 ? $$0523 : $46;
    $47 = $$0522 | 2;
    $48 = ($3>>>0)>(11);
    $49 = (12 - ($3))|0;
    $50 = ($49|0)==(0);
    $51 = $48 | $50;
    do {
     if ($51) {
      $$1472 = $38;
     } else {
      $$0511586 = 8.0;$$1510587 = $49;
      while(1) {
       $52 = (($$1510587) + -1)|0;
       $53 = $$0511586 * 16.0;
       $54 = ($52|0)==(0);
       if ($54) {
        break;
       } else {
        $$0511586 = $53;$$1510587 = $52;
       }
      }
      $55 = HEAP8[$spec$select>>0]|0;
      $56 = ($55<<24>>24)==(45);
      if ($56) {
       $57 = - $38;
       $58 = $57 - $53;
       $59 = $53 + $58;
       $60 = - $59;
       $$1472 = $60;
       break;
      } else {
       $61 = $38 + $53;
       $62 = $61 - $53;
       $$1472 = $62;
       break;
      }
     }
    } while(0);
    $63 = HEAP32[$7>>2]|0;
    $64 = ($63|0)<(0);
    $65 = (0 - ($63))|0;
    $66 = $64 ? $65 : $63;
    $67 = ($66|0)<(0);
    $68 = $67 << 31 >> 31;
    $69 = (_fmt_u($66,$68,$11)|0);
    $70 = ($69|0)==($11|0);
    if ($70) {
     $71 = ((($10)) + 11|0);
     HEAP8[$71>>0] = 48;
     $$0513 = $71;
    } else {
     $$0513 = $69;
    }
    $72 = $63 >> 31;
    $73 = $72 & 2;
    $74 = (($73) + 43)|0;
    $75 = $74&255;
    $76 = ((($$0513)) + -1|0);
    HEAP8[$76>>0] = $75;
    $77 = (($5) + 15)|0;
    $78 = $77&255;
    $79 = ((($$0513)) + -2|0);
    HEAP8[$79>>0] = $78;
    $80 = ($3|0)<(1);
    $81 = $4 & 8;
    $82 = ($81|0)==(0);
    $$0525 = $8;$$2473 = $$1472;
    while(1) {
     $83 = (~~(($$2473)));
     $84 = (5200 + ($83)|0);
     $85 = HEAP8[$84>>0]|0;
     $86 = $85&255;
     $87 = $44 | $86;
     $88 = $87&255;
     $89 = ((($$0525)) + 1|0);
     HEAP8[$$0525>>0] = $88;
     $90 = (+($83|0));
     $91 = $$2473 - $90;
     $92 = $91 * 16.0;
     $93 = $89;
     $94 = (($93) - ($9))|0;
     $95 = ($94|0)==(1);
     if ($95) {
      $96 = $92 == 0.0;
      $or$cond3$not = $80 & $96;
      $or$cond = $82 & $or$cond3$not;
      if ($or$cond) {
       $$1526 = $89;
      } else {
       $97 = ((($$0525)) + 2|0);
       HEAP8[$89>>0] = 46;
       $$1526 = $97;
      }
     } else {
      $$1526 = $89;
     }
     $98 = $92 != 0.0;
     if ($98) {
      $$0525 = $$1526;$$2473 = $92;
     } else {
      break;
     }
    }
    $99 = ($3|0)==(0);
    $$pre720 = $$1526;
    if ($99) {
     label = 25;
    } else {
     $100 = (-2 - ($9))|0;
     $101 = (($100) + ($$pre720))|0;
     $102 = ($101|0)<($3|0);
     if ($102) {
      $103 = $11;
      $104 = $79;
      $105 = (($3) + 2)|0;
      $106 = (($105) + ($103))|0;
      $107 = (($106) - ($104))|0;
      $$0527 = $107;$$pre$phi717Z2D = $103;$$pre$phi718Z2D = $104;
     } else {
      label = 25;
     }
    }
    if ((label|0) == 25) {
     $108 = $11;
     $109 = $79;
     $110 = (($108) - ($9))|0;
     $111 = (($110) - ($109))|0;
     $112 = (($111) + ($$pre720))|0;
     $$0527 = $112;$$pre$phi717Z2D = $108;$$pre$phi718Z2D = $109;
    }
    $113 = (($$0527) + ($47))|0;
    _pad_659($0,32,$2,$113,$4);
    _out_653($0,$spec$select,$47);
    $114 = $4 ^ 65536;
    _pad_659($0,48,$2,$113,$114);
    $115 = (($$pre720) - ($9))|0;
    _out_653($0,$8,$115);
    $116 = (($$pre$phi717Z2D) - ($$pre$phi718Z2D))|0;
    $117 = (($115) + ($116))|0;
    $118 = (($$0527) - ($117))|0;
    _pad_659($0,48,$118,0,0);
    _out_653($0,$79,$116);
    $119 = $4 ^ 8192;
    _pad_659($0,32,$2,$113,$119);
    $$sink757 = $113;
    break;
   }
   $120 = ($3|0)<(0);
   $spec$select539 = $120 ? 6 : $3;
   if ($39) {
    $121 = $38 * 268435456.0;
    $122 = HEAP32[$7>>2]|0;
    $123 = (($122) + -28)|0;
    HEAP32[$7>>2] = $123;
    $$3 = $121;$$pr = $123;
   } else {
    $$pre = HEAP32[$7>>2]|0;
    $$3 = $38;$$pr = $$pre;
   }
   $124 = ($$pr|0)<(0);
   $125 = ((($6)) + 288|0);
   $$0498 = $124 ? $6 : $125;
   $$1499 = $$0498;$$4 = $$3;
   while(1) {
    $126 = (~~(($$4))>>>0);
    HEAP32[$$1499>>2] = $126;
    $127 = ((($$1499)) + 4|0);
    $128 = (+($126>>>0));
    $129 = $$4 - $128;
    $130 = $129 * 1.0E+9;
    $131 = $130 != 0.0;
    if ($131) {
     $$1499 = $127;$$4 = $130;
    } else {
     break;
    }
   }
   $132 = $$0498;
   $133 = ($$pr|0)>(0);
   if ($133) {
    $$1482683 = $$0498;$$2500682 = $127;$135 = $$pr;
    while(1) {
     $134 = ($135|0)<(29);
     $136 = $134 ? $135 : 29;
     $$0488669 = ((($$2500682)) + -4|0);
     $137 = ($$0488669>>>0)<($$1482683>>>0);
     if ($137) {
      $$2483 = $$1482683;
     } else {
      $$0488671 = $$0488669;$$0497670 = 0;
      while(1) {
       $138 = HEAP32[$$0488671>>2]|0;
       $139 = (_bitshift64Shl(($138|0),0,($136|0))|0);
       $140 = (getTempRet0() | 0);
       $141 = (_i64Add(($139|0),($140|0),($$0497670|0),0)|0);
       $142 = (getTempRet0() | 0);
       $143 = (___udivdi3(($141|0),($142|0),1000000000,0)|0);
       $144 = (getTempRet0() | 0);
       $145 = (___muldi3(($143|0),($144|0),1000000000,0)|0);
       $146 = (getTempRet0() | 0);
       $147 = (_i64Subtract(($141|0),($142|0),($145|0),($146|0))|0);
       $148 = (getTempRet0() | 0);
       HEAP32[$$0488671>>2] = $147;
       $$0488 = ((($$0488671)) + -4|0);
       $149 = ($$0488>>>0)<($$1482683>>>0);
       if ($149) {
        break;
       } else {
        $$0488671 = $$0488;$$0497670 = $143;
       }
      }
      $150 = ($143|0)==(0);
      if ($150) {
       $$2483 = $$1482683;
      } else {
       $151 = ((($$1482683)) + -4|0);
       HEAP32[$151>>2] = $143;
       $$2483 = $151;
      }
     }
     $152 = ($$2500682>>>0)>($$2483>>>0);
     L57: do {
      if ($152) {
       $$3501676 = $$2500682;
       while(1) {
        $154 = ((($$3501676)) + -4|0);
        $155 = HEAP32[$154>>2]|0;
        $156 = ($155|0)==(0);
        if (!($156)) {
         $$3501$lcssa = $$3501676;
         break L57;
        }
        $153 = ($154>>>0)>($$2483>>>0);
        if ($153) {
         $$3501676 = $154;
        } else {
         $$3501$lcssa = $154;
         break;
        }
       }
      } else {
       $$3501$lcssa = $$2500682;
      }
     } while(0);
     $157 = HEAP32[$7>>2]|0;
     $158 = (($157) - ($136))|0;
     HEAP32[$7>>2] = $158;
     $159 = ($158|0)>(0);
     if ($159) {
      $$1482683 = $$2483;$$2500682 = $$3501$lcssa;$135 = $158;
     } else {
      $$1482$lcssa = $$2483;$$2500$lcssa = $$3501$lcssa;$$pr564 = $158;
      break;
     }
    }
   } else {
    $$1482$lcssa = $$0498;$$2500$lcssa = $127;$$pr564 = $$pr;
   }
   $160 = ($$pr564|0)<(0);
   if ($160) {
    $161 = (($spec$select539) + 25)|0;
    $162 = (($161|0) / 9)&-1;
    $163 = (($162) + 1)|0;
    $164 = ($42|0)==(102);
    $$3484663 = $$1482$lcssa;$$4502662 = $$2500$lcssa;$166 = $$pr564;
    while(1) {
     $165 = (0 - ($166))|0;
     $167 = ($165|0)<(9);
     $168 = $167 ? $165 : 9;
     $169 = ($$3484663>>>0)<($$4502662>>>0);
     if ($169) {
      $173 = 1 << $168;
      $174 = (($173) + -1)|0;
      $175 = 1000000000 >>> $168;
      $$0487657 = 0;$$1489656 = $$3484663;
      while(1) {
       $176 = HEAP32[$$1489656>>2]|0;
       $177 = $176 & $174;
       $178 = $176 >>> $168;
       $179 = (($178) + ($$0487657))|0;
       HEAP32[$$1489656>>2] = $179;
       $180 = Math_imul($177, $175)|0;
       $181 = ((($$1489656)) + 4|0);
       $182 = ($181>>>0)<($$4502662>>>0);
       if ($182) {
        $$0487657 = $180;$$1489656 = $181;
       } else {
        break;
       }
      }
      $183 = HEAP32[$$3484663>>2]|0;
      $184 = ($183|0)==(0);
      $185 = ((($$3484663)) + 4|0);
      $spec$select540 = $184 ? $185 : $$3484663;
      $186 = ($180|0)==(0);
      if ($186) {
       $$5503 = $$4502662;$spec$select540723 = $spec$select540;
      } else {
       $187 = ((($$4502662)) + 4|0);
       HEAP32[$$4502662>>2] = $180;
       $$5503 = $187;$spec$select540723 = $spec$select540;
      }
     } else {
      $170 = HEAP32[$$3484663>>2]|0;
      $171 = ($170|0)==(0);
      $172 = ((($$3484663)) + 4|0);
      $spec$select540722 = $171 ? $172 : $$3484663;
      $$5503 = $$4502662;$spec$select540723 = $spec$select540722;
     }
     $188 = $164 ? $$0498 : $spec$select540723;
     $189 = $$5503;
     $190 = $188;
     $191 = (($189) - ($190))|0;
     $192 = $191 >> 2;
     $193 = ($192|0)>($163|0);
     $194 = (($188) + ($163<<2)|0);
     $spec$select541 = $193 ? $194 : $$5503;
     $195 = HEAP32[$7>>2]|0;
     $196 = (($195) + ($168))|0;
     HEAP32[$7>>2] = $196;
     $197 = ($196|0)<(0);
     if ($197) {
      $$3484663 = $spec$select540723;$$4502662 = $spec$select541;$166 = $196;
     } else {
      $$3484$lcssa = $spec$select540723;$$4502$lcssa = $spec$select541;
      break;
     }
    }
   } else {
    $$3484$lcssa = $$1482$lcssa;$$4502$lcssa = $$2500$lcssa;
   }
   $198 = ($$3484$lcssa>>>0)<($$4502$lcssa>>>0);
   if ($198) {
    $199 = $$3484$lcssa;
    $200 = (($132) - ($199))|0;
    $201 = $200 >> 2;
    $202 = ($201*9)|0;
    $203 = HEAP32[$$3484$lcssa>>2]|0;
    $204 = ($203>>>0)<(10);
    if ($204) {
     $$1517 = $202;
    } else {
     $$0516652 = $202;$$0532651 = 10;
     while(1) {
      $205 = ($$0532651*10)|0;
      $206 = (($$0516652) + 1)|0;
      $207 = ($203>>>0)<($205>>>0);
      if ($207) {
       $$1517 = $206;
       break;
      } else {
       $$0516652 = $206;$$0532651 = $205;
      }
     }
    }
   } else {
    $$1517 = 0;
   }
   $208 = ($42|0)==(102);
   $209 = $208 ? 0 : $$1517;
   $210 = (($spec$select539) - ($209))|0;
   $211 = ($42|0)==(103);
   $212 = ($spec$select539|0)!=(0);
   $213 = $212 & $211;
   $$neg = $213 << 31 >> 31;
   $214 = (($210) + ($$neg))|0;
   $215 = $$4502$lcssa;
   $216 = (($215) - ($132))|0;
   $217 = $216 >> 2;
   $218 = ($217*9)|0;
   $219 = (($218) + -9)|0;
   $220 = ($214|0)<($219|0);
   if ($220) {
    $221 = ((($$0498)) + 4|0);
    $222 = (($214) + 9216)|0;
    $223 = (($222|0) / 9)&-1;
    $224 = (($223) + -1024)|0;
    $225 = (($221) + ($224<<2)|0);
    $226 = ($223*9)|0;
    $227 = (($222) - ($226))|0;
    $228 = ($227|0)<(8);
    if ($228) {
     $$0529$in646 = $227;$$1533645 = 10;
     while(1) {
      $$0529 = (($$0529$in646) + 1)|0;
      $229 = ($$1533645*10)|0;
      $230 = ($$0529$in646|0)<(7);
      if ($230) {
       $$0529$in646 = $$0529;$$1533645 = $229;
      } else {
       $$1533$lcssa = $229;
       break;
      }
     }
    } else {
     $$1533$lcssa = 10;
    }
    $231 = HEAP32[$225>>2]|0;
    $232 = (($231>>>0) / ($$1533$lcssa>>>0))&-1;
    $233 = Math_imul($232, $$1533$lcssa)|0;
    $234 = (($231) - ($233))|0;
    $235 = ($234|0)==(0);
    $236 = ((($225)) + 4|0);
    $237 = ($236|0)==($$4502$lcssa|0);
    $or$cond543 = $237 & $235;
    if ($or$cond543) {
     $$4492 = $225;$$4520 = $$1517;$$8 = $$3484$lcssa;
    } else {
     $238 = $232 & 1;
     $239 = ($238|0)==(0);
     $spec$select544 = $239 ? 9007199254740992.0 : 9007199254740994.0;
     $240 = $$1533$lcssa >>> 1;
     $241 = ($234>>>0)<($240>>>0);
     $242 = ($234|0)==($240|0);
     $or$cond546 = $237 & $242;
     $spec$select561 = $or$cond546 ? 1.0 : 1.5;
     $spec$select567 = $241 ? 0.5 : $spec$select561;
     $243 = ($$0522|0)==(0);
     if ($243) {
      $$1467 = $spec$select567;$$1469 = $spec$select544;
     } else {
      $244 = HEAP8[$$0523>>0]|0;
      $245 = ($244<<24>>24)==(45);
      $246 = - $spec$select544;
      $247 = - $spec$select567;
      $spec$select568 = $245 ? $246 : $spec$select544;
      $spec$select569 = $245 ? $247 : $spec$select567;
      $$1467 = $spec$select569;$$1469 = $spec$select568;
     }
     $248 = (($231) - ($234))|0;
     HEAP32[$225>>2] = $248;
     $249 = $$1469 + $$1467;
     $250 = $249 != $$1469;
     if ($250) {
      $251 = (($248) + ($$1533$lcssa))|0;
      HEAP32[$225>>2] = $251;
      $252 = ($251>>>0)>(999999999);
      if ($252) {
       $$2490638 = $225;$$5486639 = $$3484$lcssa;
       while(1) {
        $253 = ((($$2490638)) + -4|0);
        HEAP32[$$2490638>>2] = 0;
        $254 = ($253>>>0)<($$5486639>>>0);
        if ($254) {
         $255 = ((($$5486639)) + -4|0);
         HEAP32[$255>>2] = 0;
         $$6 = $255;
        } else {
         $$6 = $$5486639;
        }
        $256 = HEAP32[$253>>2]|0;
        $257 = (($256) + 1)|0;
        HEAP32[$253>>2] = $257;
        $258 = ($257>>>0)>(999999999);
        if ($258) {
         $$2490638 = $253;$$5486639 = $$6;
        } else {
         $$2490$lcssa = $253;$$5486$lcssa = $$6;
         break;
        }
       }
      } else {
       $$2490$lcssa = $225;$$5486$lcssa = $$3484$lcssa;
      }
      $259 = $$5486$lcssa;
      $260 = (($132) - ($259))|0;
      $261 = $260 >> 2;
      $262 = ($261*9)|0;
      $263 = HEAP32[$$5486$lcssa>>2]|0;
      $264 = ($263>>>0)<(10);
      if ($264) {
       $$4492 = $$2490$lcssa;$$4520 = $262;$$8 = $$5486$lcssa;
      } else {
       $$2518634 = $262;$$2534633 = 10;
       while(1) {
        $265 = ($$2534633*10)|0;
        $266 = (($$2518634) + 1)|0;
        $267 = ($263>>>0)<($265>>>0);
        if ($267) {
         $$4492 = $$2490$lcssa;$$4520 = $266;$$8 = $$5486$lcssa;
         break;
        } else {
         $$2518634 = $266;$$2534633 = $265;
        }
       }
      }
     } else {
      $$4492 = $225;$$4520 = $$1517;$$8 = $$3484$lcssa;
     }
    }
    $268 = ((($$4492)) + 4|0);
    $269 = ($$4502$lcssa>>>0)>($268>>>0);
    $spec$select547 = $269 ? $268 : $$4502$lcssa;
    $$5521 = $$4520;$$8506 = $spec$select547;$$9 = $$8;
   } else {
    $$5521 = $$1517;$$8506 = $$4502$lcssa;$$9 = $$3484$lcssa;
   }
   $270 = (0 - ($$5521))|0;
   $271 = ($$8506>>>0)>($$9>>>0);
   L109: do {
    if ($271) {
     $$9507625 = $$8506;
     while(1) {
      $273 = ((($$9507625)) + -4|0);
      $274 = HEAP32[$273>>2]|0;
      $275 = ($274|0)==(0);
      if (!($275)) {
       $$9507$lcssa = $$9507625;$$lcssa583 = 1;
       break L109;
      }
      $272 = ($273>>>0)>($$9>>>0);
      if ($272) {
       $$9507625 = $273;
      } else {
       $$9507$lcssa = $273;$$lcssa583 = 0;
       break;
      }
     }
    } else {
     $$9507$lcssa = $$8506;$$lcssa583 = 0;
    }
   } while(0);
   do {
    if ($211) {
     $not$ = $212 ^ 1;
     $276 = $not$&1;
     $spec$select548 = (($spec$select539) + ($276))|0;
     $277 = ($spec$select548|0)>($$5521|0);
     $278 = ($$5521|0)>(-5);
     $or$cond6 = $277 & $278;
     if ($or$cond6) {
      $279 = (($5) + -1)|0;
      $$neg571 = (($spec$select548) + -1)|0;
      $280 = (($$neg571) - ($$5521))|0;
      $$0479 = $279;$$2476 = $280;
     } else {
      $281 = (($5) + -2)|0;
      $282 = (($spec$select548) + -1)|0;
      $$0479 = $281;$$2476 = $282;
     }
     $283 = $4 & 8;
     $284 = ($283|0)==(0);
     if ($284) {
      if ($$lcssa583) {
       $285 = ((($$9507$lcssa)) + -4|0);
       $286 = HEAP32[$285>>2]|0;
       $287 = ($286|0)==(0);
       if ($287) {
        $$2531 = 9;
       } else {
        $288 = (($286>>>0) % 10)&-1;
        $289 = ($288|0)==(0);
        if ($289) {
         $$1530621 = 0;$$3535620 = 10;
         while(1) {
          $290 = ($$3535620*10)|0;
          $291 = (($$1530621) + 1)|0;
          $292 = (($286>>>0) % ($290>>>0))&-1;
          $293 = ($292|0)==(0);
          if ($293) {
           $$1530621 = $291;$$3535620 = $290;
          } else {
           $$2531 = $291;
           break;
          }
         }
        } else {
         $$2531 = 0;
        }
       }
      } else {
       $$2531 = 9;
      }
      $294 = $$0479 | 32;
      $295 = ($294|0)==(102);
      $296 = $$9507$lcssa;
      $297 = (($296) - ($132))|0;
      $298 = $297 >> 2;
      $299 = ($298*9)|0;
      $300 = (($299) + -9)|0;
      if ($295) {
       $301 = (($300) - ($$2531))|0;
       $302 = ($301|0)>(0);
       $spec$select549 = $302 ? $301 : 0;
       $303 = ($$2476|0)<($spec$select549|0);
       $spec$select562 = $303 ? $$2476 : $spec$select549;
       $$1480 = $$0479;$$3477 = $spec$select562;
       break;
      } else {
       $304 = (($300) + ($$5521))|0;
       $305 = (($304) - ($$2531))|0;
       $306 = ($305|0)>(0);
       $spec$select551 = $306 ? $305 : 0;
       $307 = ($$2476|0)<($spec$select551|0);
       $spec$select563 = $307 ? $$2476 : $spec$select551;
       $$1480 = $$0479;$$3477 = $spec$select563;
       break;
      }
     } else {
      $$1480 = $$0479;$$3477 = $$2476;
     }
    } else {
     $$1480 = $5;$$3477 = $spec$select539;
    }
   } while(0);
   $308 = ($$3477|0)!=(0);
   $309 = $4 >>> 3;
   $$lobit = $309 & 1;
   $310 = $308 ? 1 : $$lobit;
   $311 = $$1480 | 32;
   $312 = ($311|0)==(102);
   if ($312) {
    $313 = ($$5521|0)>(0);
    $314 = $313 ? $$5521 : 0;
    $$2515 = 0;$$pn = $314;
   } else {
    $315 = ($$5521|0)<(0);
    $316 = $315 ? $270 : $$5521;
    $317 = ($316|0)<(0);
    $318 = $317 << 31 >> 31;
    $319 = (_fmt_u($316,$318,$11)|0);
    $320 = $11;
    $321 = $319;
    $322 = (($320) - ($321))|0;
    $323 = ($322|0)<(2);
    if ($323) {
     $$1514614 = $319;
     while(1) {
      $324 = ((($$1514614)) + -1|0);
      HEAP8[$324>>0] = 48;
      $325 = $324;
      $326 = (($320) - ($325))|0;
      $327 = ($326|0)<(2);
      if ($327) {
       $$1514614 = $324;
      } else {
       $$1514$lcssa = $324;
       break;
      }
     }
    } else {
     $$1514$lcssa = $319;
    }
    $328 = $$5521 >> 31;
    $329 = $328 & 2;
    $330 = (($329) + 43)|0;
    $331 = $330&255;
    $332 = ((($$1514$lcssa)) + -1|0);
    HEAP8[$332>>0] = $331;
    $333 = $$1480&255;
    $334 = ((($$1514$lcssa)) + -2|0);
    HEAP8[$334>>0] = $333;
    $335 = $334;
    $336 = (($320) - ($335))|0;
    $$2515 = $334;$$pn = $336;
   }
   $337 = (($$0522) + 1)|0;
   $338 = (($337) + ($$3477))|0;
   $$1528 = (($338) + ($310))|0;
   $339 = (($$1528) + ($$pn))|0;
   _pad_659($0,32,$2,$339,$4);
   _out_653($0,$$0523,$$0522);
   $340 = $4 ^ 65536;
   _pad_659($0,48,$2,$339,$340);
   if ($312) {
    $341 = ($$9>>>0)>($$0498>>>0);
    $spec$select554 = $341 ? $$0498 : $$9;
    $342 = ((($8)) + 9|0);
    $343 = $342;
    $344 = ((($8)) + 8|0);
    $$5493603 = $spec$select554;
    while(1) {
     $345 = HEAP32[$$5493603>>2]|0;
     $346 = (_fmt_u($345,0,$342)|0);
     $347 = ($$5493603|0)==($spec$select554|0);
     if ($347) {
      $353 = ($346|0)==($342|0);
      if ($353) {
       HEAP8[$344>>0] = 48;
       $$1465 = $344;
      } else {
       $$1465 = $346;
      }
     } else {
      $348 = ($346>>>0)>($8>>>0);
      if ($348) {
       $349 = $346;
       $350 = (($349) - ($9))|0;
       _memset(($8|0),48,($350|0))|0;
       $$0464599 = $346;
       while(1) {
        $351 = ((($$0464599)) + -1|0);
        $352 = ($351>>>0)>($8>>>0);
        if ($352) {
         $$0464599 = $351;
        } else {
         $$1465 = $351;
         break;
        }
       }
      } else {
       $$1465 = $346;
      }
     }
     $354 = $$1465;
     $355 = (($343) - ($354))|0;
     _out_653($0,$$1465,$355);
     $356 = ((($$5493603)) + 4|0);
     $357 = ($356>>>0)>($$0498>>>0);
     if ($357) {
      break;
     } else {
      $$5493603 = $356;
     }
    }
    $$not = $308 ^ 1;
    $358 = $4 & 8;
    $359 = ($358|0)==(0);
    $or$cond556 = $359 & $$not;
    if (!($or$cond556)) {
     _out_653($0,8184,1);
    }
    $360 = ($356>>>0)<($$9507$lcssa>>>0);
    $361 = ($$3477|0)>(0);
    $362 = $360 & $361;
    if ($362) {
     $$4478594 = $$3477;$$6494593 = $356;
     while(1) {
      $363 = HEAP32[$$6494593>>2]|0;
      $364 = (_fmt_u($363,0,$342)|0);
      $365 = ($364>>>0)>($8>>>0);
      if ($365) {
       $366 = $364;
       $367 = (($366) - ($9))|0;
       _memset(($8|0),48,($367|0))|0;
       $$0463588 = $364;
       while(1) {
        $368 = ((($$0463588)) + -1|0);
        $369 = ($368>>>0)>($8>>>0);
        if ($369) {
         $$0463588 = $368;
        } else {
         $$0463$lcssa = $368;
         break;
        }
       }
      } else {
       $$0463$lcssa = $364;
      }
      $370 = ($$4478594|0)<(9);
      $371 = $370 ? $$4478594 : 9;
      _out_653($0,$$0463$lcssa,$371);
      $372 = ((($$6494593)) + 4|0);
      $373 = (($$4478594) + -9)|0;
      $374 = ($372>>>0)<($$9507$lcssa>>>0);
      $375 = ($$4478594|0)>(9);
      $376 = $374 & $375;
      if ($376) {
       $$4478594 = $373;$$6494593 = $372;
      } else {
       $$4478$lcssa = $373;
       break;
      }
     }
    } else {
     $$4478$lcssa = $$3477;
    }
    $377 = (($$4478$lcssa) + 9)|0;
    _pad_659($0,48,$377,9,0);
   } else {
    $378 = ((($$9)) + 4|0);
    $spec$select557 = $$lcssa583 ? $$9507$lcssa : $378;
    $379 = ($$9>>>0)<($spec$select557>>>0);
    $380 = ($$3477|0)>(-1);
    $381 = $379 & $380;
    if ($381) {
     $382 = ((($8)) + 9|0);
     $383 = $4 & 8;
     $384 = ($383|0)==(0);
     $385 = $382;
     $386 = (0 - ($9))|0;
     $387 = ((($8)) + 8|0);
     $$5609 = $$3477;$$7495608 = $$9;
     while(1) {
      $388 = HEAP32[$$7495608>>2]|0;
      $389 = (_fmt_u($388,0,$382)|0);
      $390 = ($389|0)==($382|0);
      if ($390) {
       HEAP8[$387>>0] = 48;
       $$0 = $387;
      } else {
       $$0 = $389;
      }
      $391 = ($$7495608|0)==($$9|0);
      do {
       if ($391) {
        $395 = ((($$0)) + 1|0);
        _out_653($0,$$0,1);
        $396 = ($$5609|0)<(1);
        $or$cond559 = $384 & $396;
        if ($or$cond559) {
         $$2 = $395;
         break;
        }
        _out_653($0,8184,1);
        $$2 = $395;
       } else {
        $392 = ($$0>>>0)>($8>>>0);
        if (!($392)) {
         $$2 = $$0;
         break;
        }
        $scevgep711 = (($$0) + ($386)|0);
        $scevgep711712 = $scevgep711;
        _memset(($8|0),48,($scevgep711712|0))|0;
        $$1604 = $$0;
        while(1) {
         $393 = ((($$1604)) + -1|0);
         $394 = ($393>>>0)>($8>>>0);
         if ($394) {
          $$1604 = $393;
         } else {
          $$2 = $393;
          break;
         }
        }
       }
      } while(0);
      $397 = $$2;
      $398 = (($385) - ($397))|0;
      $399 = ($$5609|0)>($398|0);
      $400 = $399 ? $398 : $$5609;
      _out_653($0,$$2,$400);
      $401 = (($$5609) - ($398))|0;
      $402 = ((($$7495608)) + 4|0);
      $403 = ($402>>>0)<($spec$select557>>>0);
      $404 = ($401|0)>(-1);
      $405 = $403 & $404;
      if ($405) {
       $$5609 = $401;$$7495608 = $402;
      } else {
       $$5$lcssa = $401;
       break;
      }
     }
    } else {
     $$5$lcssa = $$3477;
    }
    $406 = (($$5$lcssa) + 18)|0;
    _pad_659($0,48,$406,18,0);
    $407 = $11;
    $408 = $$2515;
    $409 = (($407) - ($408))|0;
    _out_653($0,$$2515,$409);
   }
   $410 = $4 ^ 8192;
   _pad_659($0,32,$2,$339,$410);
   $$sink757 = $339;
  }
 } while(0);
 $411 = ($$sink757|0)<($2|0);
 $$560 = $411 ? $2 : $$sink757;
 STACKTOP = sp;return ($$560|0);
}
function _pop_arg_long_double($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0.0, $arglist_current = 0, $arglist_next = 0, $expanded = 0, $expanded1 = 0, $expanded3 = 0, $expanded4 = 0, $expanded5 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $arglist_current = HEAP32[$1>>2]|0;
 $2 = $arglist_current;
 $3 = ((0) + 8|0);
 $expanded1 = $3;
 $expanded = (($expanded1) - 1)|0;
 $4 = (($2) + ($expanded))|0;
 $5 = ((0) + 8|0);
 $expanded5 = $5;
 $expanded4 = (($expanded5) - 1)|0;
 $expanded3 = $expanded4 ^ -1;
 $6 = $4 & $expanded3;
 $7 = $6;
 $8 = +HEAPF64[$7>>3];
 $arglist_next = ((($7)) + 8|0);
 HEAP32[$1>>2] = $arglist_next;
 HEAPF64[$0>>3] = $8;
 return;
}
function ___vfprintf_internal($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$0 = 0, $$1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0;
 var $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0, $42 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
 var $spec$select = 0, $spec$select45 = 0, $vacopy_currentptr = 0, dest = 0, label = 0, sp = 0, stop = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 224|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(224|0);
 $5 = sp + 208|0;
 $6 = sp + 160|0;
 $7 = sp + 80|0;
 $8 = sp;
 dest=$6; stop=dest+40|0; do { HEAP32[dest>>2]=0|0; dest=dest+4|0; } while ((dest|0) < (stop|0));
 $vacopy_currentptr = HEAP32[$2>>2]|0;
 HEAP32[$5>>2] = $vacopy_currentptr;
 $9 = (_printf_core(0,$1,$5,$7,$6,$3,$4)|0);
 $10 = ($9|0)<(0);
 if ($10) {
  $$0 = -1;
 } else {
  $11 = ((($0)) + 76|0);
  $12 = HEAP32[$11>>2]|0;
  $13 = ($12|0)>(-1);
  if ($13) {
   $14 = (___lockfile($0)|0);
   $42 = $14;
  } else {
   $42 = 0;
  }
  $15 = HEAP32[$0>>2]|0;
  $16 = $15 & 32;
  $17 = ((($0)) + 74|0);
  $18 = HEAP8[$17>>0]|0;
  $19 = ($18<<24>>24)<(1);
  if ($19) {
   $20 = $15 & -33;
   HEAP32[$0>>2] = $20;
  }
  $21 = ((($0)) + 48|0);
  $22 = HEAP32[$21>>2]|0;
  $23 = ($22|0)==(0);
  if ($23) {
   $25 = ((($0)) + 44|0);
   $26 = HEAP32[$25>>2]|0;
   HEAP32[$25>>2] = $8;
   $27 = ((($0)) + 28|0);
   HEAP32[$27>>2] = $8;
   $28 = ((($0)) + 20|0);
   HEAP32[$28>>2] = $8;
   HEAP32[$21>>2] = 80;
   $29 = ((($8)) + 80|0);
   $30 = ((($0)) + 16|0);
   HEAP32[$30>>2] = $29;
   $31 = (_printf_core($0,$1,$5,$7,$6,$3,$4)|0);
   $32 = ($26|0)==(0|0);
   if ($32) {
    $$1 = $31;
   } else {
    $33 = ((($0)) + 36|0);
    $34 = HEAP32[$33>>2]|0;
    (FUNCTION_TABLE_iiii[$34 & 3]($0,0,0)|0);
    $35 = HEAP32[$28>>2]|0;
    $36 = ($35|0)==(0|0);
    $spec$select = $36 ? -1 : $31;
    HEAP32[$25>>2] = $26;
    HEAP32[$21>>2] = 0;
    HEAP32[$30>>2] = 0;
    HEAP32[$27>>2] = 0;
    HEAP32[$28>>2] = 0;
    $$1 = $spec$select;
   }
  } else {
   $24 = (_printf_core($0,$1,$5,$7,$6,$3,$4)|0);
   $$1 = $24;
  }
  $37 = HEAP32[$0>>2]|0;
  $38 = $37 & 32;
  $39 = ($38|0)==(0);
  $spec$select45 = $39 ? $$1 : -1;
  $40 = $37 | $16;
  HEAP32[$0>>2] = $40;
  $41 = ($42|0)==(0);
  if (!($41)) {
   ___unlockfile($0);
  }
  $$0 = $spec$select45;
 }
 STACKTOP = sp;return ($$0|0);
}
function _printf_core($0,$1,$2,$3,$4,$5,$6) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 $5 = $5|0;
 $6 = $6|0;
 var $$ = 0, $$0 = 0, $$0231 = 0, $$0232336 = 0, $$0234 = 0, $$0237 = 0, $$0239 = 0, $$0242315 = 0, $$0242315373 = 0, $$0242335 = 0, $$0245 = 0, $$0245$ph = 0, $$0245$ph$be = 0, $$0249 = 0, $$0249$ph = 0, $$0251$lcssa = 0, $$0251323 = 0, $$0254 = 0, $$0255 = 0, $$0256 = 0;
 var $$0261 = 0, $$0264$lcssa = 0, $$0264330 = 0, $$0271$ph = 0, $$1 = 0, $$1233342 = 0, $$1235 = 0, $$1238 = 0, $$1240 = 0, $$1243341 = 0, $$1250 = 0, $$1252 = 0, $$1257 = 0, $$1262 = 0, $$1265 = 0, $$1272 = 0, $$2236 = 0, $$2241 = 0, $$2244322 = 0, $$2258 = 0;
 var $$2258$ = 0, $$2263 = 0, $$2273 = 0, $$3259 = 0, $$3267 = 0, $$3274 = 0, $$3319 = 0, $$4260372 = 0, $$4268 = 0, $$5 = 0, $$6270 = 0, $$lcssa310 = 0, $$pre = 0, $$pre$phiZ2D = 0, $$pre362 = 0, $$pre364 = 0, $$pre365 = 0, $$pre365$pre = 0, $$pre366 = 0, $$pre370 = 0;
 var $$sink = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0;
 var $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0;
 var $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0;
 var $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0, $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0;
 var $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0, $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0;
 var $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0, $198 = 0, $199 = 0, $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0;
 var $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0, $215 = 0, $216 = 0, $217 = 0, $218 = 0, $219 = 0, $22 = 0, $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0;
 var $226 = 0, $227 = 0, $228 = 0, $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0, $233 = 0, $234 = 0, $235 = 0, $236 = 0, $237 = 0, $238 = 0, $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0;
 var $244 = 0, $245 = 0, $246 = 0, $247 = 0, $248 = 0, $249 = 0, $25 = 0, $250 = 0, $251 = 0, $252 = 0, $253 = 0, $254 = 0, $255 = 0, $256 = 0, $257 = 0, $258 = 0, $259 = 0, $26 = 0, $260 = 0, $261 = 0;
 var $262 = 0, $263 = 0, $264 = 0, $265 = 0, $266 = 0, $267 = 0, $268 = 0, $269 = 0, $27 = 0, $270 = 0, $271 = 0, $272 = 0, $273 = 0, $274 = 0, $275 = 0, $276 = 0, $277 = 0, $278 = 0, $279 = 0, $28 = 0;
 var $280 = 0, $281 = 0, $282 = 0, $283 = 0, $284 = 0, $285 = 0, $286 = 0, $287 = 0, $288 = 0, $289 = 0, $29 = 0, $290 = 0, $291 = 0, $292 = 0, $293 = 0, $294 = 0, $295 = 0, $296 = 0, $297 = 0, $298 = 0;
 var $299 = 0, $30 = 0, $300 = 0, $301 = 0, $302 = 0, $303 = 0, $304 = 0, $305 = 0, $306 = 0, $307 = 0, $308 = 0, $309 = 0, $31 = 0, $310 = 0, $311 = 0, $312 = 0, $313 = 0, $314 = 0, $315 = 0, $316 = 0;
 var $317 = 0, $318 = 0, $319 = 0, $32 = 0, $320 = 0, $321 = 0, $322 = 0, $323 = 0, $324 = 0, $325 = 0, $326 = 0, $327 = 0, $328 = 0, $329 = 0, $33 = 0, $330 = 0, $331 = 0, $332 = 0, $333 = 0, $334 = 0;
 var $335 = 0, $336 = 0, $337 = 0, $338 = 0, $339 = 0, $34 = 0, $340 = 0, $341 = 0, $342 = 0, $343 = 0, $344 = 0, $345 = 0.0, $346 = 0, $347 = 0, $348 = 0, $349 = 0, $35 = 0, $350 = 0, $351 = 0, $352 = 0;
 var $353 = 0, $354 = 0, $355 = 0, $356 = 0, $357 = 0, $358 = 0, $359 = 0, $36 = 0, $360 = 0, $361 = 0, $362 = 0, $363 = 0, $364 = 0, $365 = 0, $366 = 0, $367 = 0, $368 = 0, $37 = 0, $38 = 0, $39 = 0;
 var $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0;
 var $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0;
 var $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0;
 var $97 = 0, $98 = 0, $99 = 0, $arglist_current = 0, $arglist_current2 = 0, $arglist_next = 0, $arglist_next3 = 0, $brmerge = 0, $brmerge328 = 0, $expanded = 0, $expanded10 = 0, $expanded11 = 0, $expanded13 = 0, $expanded14 = 0, $expanded15 = 0, $expanded4 = 0, $expanded6 = 0, $expanded7 = 0, $expanded8 = 0, $or$cond = 0;
 var $or$cond278 = 0, $or$cond280 = 0, $or$cond285 = 0, $spec$select = 0, $spec$select283 = 0, $spec$select286 = 0, $spec$select293 = 0, $spec$select294 = 0, $spec$select295 = 0, $spec$select296 = 0, $spec$select297 = 0, $spec$select298 = 0, $spec$select299 = 0, $spec$select300 = 0, $spec$select301 = 0, $storemerge275$lcssa = 0, $storemerge275329 = 0, $storemerge276 = 0, $trunc = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 64|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(64|0);
 $7 = sp + 56|0;
 $8 = sp + 40|0;
 $9 = sp;
 $10 = sp + 48|0;
 $11 = sp + 60|0;
 HEAP32[$7>>2] = $1;
 $12 = ($0|0)!=(0|0);
 $13 = ((($9)) + 40|0);
 $14 = $13;
 $15 = ((($9)) + 39|0);
 $16 = ((($10)) + 4|0);
 $$0245$ph = 0;$$0249$ph = 0;$$0271$ph = 0;
 L1: while(1) {
  $$0245 = $$0245$ph;$$0249 = $$0249$ph;
  while(1) {
   $17 = ($$0249|0)>(-1);
   do {
    if ($17) {
     $18 = (2147483647 - ($$0249))|0;
     $19 = ($$0245|0)>($18|0);
     if ($19) {
      $20 = (___errno_location()|0);
      HEAP32[$20>>2] = 75;
      $$1250 = -1;
      break;
     } else {
      $21 = (($$0245) + ($$0249))|0;
      $$1250 = $21;
      break;
     }
    } else {
     $$1250 = $$0249;
    }
   } while(0);
   $22 = HEAP32[$7>>2]|0;
   $23 = HEAP8[$22>>0]|0;
   $24 = ($23<<24>>24)==(0);
   if ($24) {
    label = 92;
    break L1;
   }
   $25 = $23;$27 = $22;
   L12: while(1) {
    switch ($25<<24>>24) {
    case 37:  {
     label = 10;
     break L12;
     break;
    }
    case 0:  {
     $$0251$lcssa = $27;
     break L12;
     break;
    }
    default: {
    }
    }
    $26 = ((($27)) + 1|0);
    HEAP32[$7>>2] = $26;
    $$pre = HEAP8[$26>>0]|0;
    $25 = $$pre;$27 = $26;
   }
   L15: do {
    if ((label|0) == 10) {
     label = 0;
     $$0251323 = $27;$29 = $27;
     while(1) {
      $28 = ((($29)) + 1|0);
      $30 = HEAP8[$28>>0]|0;
      $31 = ($30<<24>>24)==(37);
      if (!($31)) {
       $$0251$lcssa = $$0251323;
       break L15;
      }
      $32 = ((($$0251323)) + 1|0);
      $33 = ((($29)) + 2|0);
      HEAP32[$7>>2] = $33;
      $34 = HEAP8[$33>>0]|0;
      $35 = ($34<<24>>24)==(37);
      if ($35) {
       $$0251323 = $32;$29 = $33;
      } else {
       $$0251$lcssa = $32;
       break;
      }
     }
    }
   } while(0);
   $36 = $$0251$lcssa;
   $37 = $22;
   $38 = (($36) - ($37))|0;
   if ($12) {
    _out_653($0,$22,$38);
   }
   $39 = ($38|0)==(0);
   if ($39) {
    break;
   } else {
    $$0245 = $38;$$0249 = $$1250;
   }
  }
  $40 = HEAP32[$7>>2]|0;
  $41 = ((($40)) + 1|0);
  $42 = HEAP8[$41>>0]|0;
  $43 = $42 << 24 >> 24;
  $44 = (_isdigit($43)|0);
  $45 = ($44|0)==(0);
  $$pre362 = HEAP32[$7>>2]|0;
  if ($45) {
   $$0255 = -1;$$1272 = $$0271$ph;$$sink = 1;
  } else {
   $46 = ((($$pre362)) + 2|0);
   $47 = HEAP8[$46>>0]|0;
   $48 = ($47<<24>>24)==(36);
   if ($48) {
    $49 = ((($$pre362)) + 1|0);
    $50 = HEAP8[$49>>0]|0;
    $51 = $50 << 24 >> 24;
    $52 = (($51) + -48)|0;
    $$0255 = $52;$$1272 = 1;$$sink = 3;
   } else {
    $$0255 = -1;$$1272 = $$0271$ph;$$sink = 1;
   }
  }
  $53 = (($$pre362) + ($$sink)|0);
  HEAP32[$7>>2] = $53;
  $54 = HEAP8[$53>>0]|0;
  $55 = $54 << 24 >> 24;
  $56 = (($55) + -32)|0;
  $57 = ($56>>>0)>(31);
  $58 = 1 << $56;
  $59 = $58 & 75913;
  $60 = ($59|0)==(0);
  $brmerge328 = $57 | $60;
  if ($brmerge328) {
   $$0264$lcssa = 0;$$lcssa310 = $54;$storemerge275$lcssa = $53;
  } else {
   $$0264330 = 0;$62 = $56;$storemerge275329 = $53;
   while(1) {
    $61 = 1 << $62;
    $63 = $61 | $$0264330;
    $64 = ((($storemerge275329)) + 1|0);
    HEAP32[$7>>2] = $64;
    $65 = HEAP8[$64>>0]|0;
    $66 = $65 << 24 >> 24;
    $67 = (($66) + -32)|0;
    $68 = ($67>>>0)>(31);
    $69 = 1 << $67;
    $70 = $69 & 75913;
    $71 = ($70|0)==(0);
    $brmerge = $68 | $71;
    if ($brmerge) {
     $$0264$lcssa = $63;$$lcssa310 = $65;$storemerge275$lcssa = $64;
     break;
    } else {
     $$0264330 = $63;$62 = $67;$storemerge275329 = $64;
    }
   }
  }
  $72 = ($$lcssa310<<24>>24)==(42);
  if ($72) {
   $73 = ((($storemerge275$lcssa)) + 1|0);
   $74 = HEAP8[$73>>0]|0;
   $75 = $74 << 24 >> 24;
   $76 = (_isdigit($75)|0);
   $77 = ($76|0)==(0);
   if ($77) {
    label = 27;
   } else {
    $78 = HEAP32[$7>>2]|0;
    $79 = ((($78)) + 2|0);
    $80 = HEAP8[$79>>0]|0;
    $81 = ($80<<24>>24)==(36);
    if ($81) {
     $82 = ((($78)) + 1|0);
     $83 = HEAP8[$82>>0]|0;
     $84 = $83 << 24 >> 24;
     $85 = (($84) + -48)|0;
     $86 = (($4) + ($85<<2)|0);
     HEAP32[$86>>2] = 10;
     $87 = HEAP8[$82>>0]|0;
     $88 = $87 << 24 >> 24;
     $89 = (($88) + -48)|0;
     $90 = (($3) + ($89<<3)|0);
     $91 = $90;
     $92 = $91;
     $93 = HEAP32[$92>>2]|0;
     $94 = (($91) + 4)|0;
     $95 = $94;
     $96 = HEAP32[$95>>2]|0;
     $97 = ((($78)) + 3|0);
     $$0261 = $93;$$2273 = 1;$storemerge276 = $97;
    } else {
     label = 27;
    }
   }
   if ((label|0) == 27) {
    label = 0;
    $98 = ($$1272|0)==(0);
    if (!($98)) {
     $$0 = -1;
     break;
    }
    if ($12) {
     $arglist_current = HEAP32[$2>>2]|0;
     $99 = $arglist_current;
     $100 = ((0) + 4|0);
     $expanded4 = $100;
     $expanded = (($expanded4) - 1)|0;
     $101 = (($99) + ($expanded))|0;
     $102 = ((0) + 4|0);
     $expanded8 = $102;
     $expanded7 = (($expanded8) - 1)|0;
     $expanded6 = $expanded7 ^ -1;
     $103 = $101 & $expanded6;
     $104 = $103;
     $105 = HEAP32[$104>>2]|0;
     $arglist_next = ((($104)) + 4|0);
     HEAP32[$2>>2] = $arglist_next;
     $367 = $105;
    } else {
     $367 = 0;
    }
    $106 = HEAP32[$7>>2]|0;
    $107 = ((($106)) + 1|0);
    $$0261 = $367;$$2273 = 0;$storemerge276 = $107;
   }
   HEAP32[$7>>2] = $storemerge276;
   $108 = ($$0261|0)<(0);
   $109 = $$0264$lcssa | 8192;
   $110 = (0 - ($$0261))|0;
   $spec$select293 = $108 ? $109 : $$0264$lcssa;
   $spec$select294 = $108 ? $110 : $$0261;
   $$1262 = $spec$select294;$$1265 = $spec$select293;$$3274 = $$2273;$114 = $storemerge276;
  } else {
   $111 = (_getint_654($7)|0);
   $112 = ($111|0)<(0);
   if ($112) {
    $$0 = -1;
    break;
   }
   $$pre364 = HEAP32[$7>>2]|0;
   $$1262 = $111;$$1265 = $$0264$lcssa;$$3274 = $$1272;$114 = $$pre364;
  }
  $113 = HEAP8[$114>>0]|0;
  $115 = ($113<<24>>24)==(46);
  do {
   if ($115) {
    $116 = ((($114)) + 1|0);
    $117 = HEAP8[$116>>0]|0;
    $118 = ($117<<24>>24)==(42);
    if (!($118)) {
     HEAP32[$7>>2] = $116;
     $154 = (_getint_654($7)|0);
     $$pre365$pre = HEAP32[$7>>2]|0;
     $$0256 = $154;$$pre365 = $$pre365$pre;
     break;
    }
    $119 = ((($114)) + 2|0);
    $120 = HEAP8[$119>>0]|0;
    $121 = $120 << 24 >> 24;
    $122 = (_isdigit($121)|0);
    $123 = ($122|0)==(0);
    if (!($123)) {
     $124 = HEAP32[$7>>2]|0;
     $125 = ((($124)) + 3|0);
     $126 = HEAP8[$125>>0]|0;
     $127 = ($126<<24>>24)==(36);
     if ($127) {
      $128 = ((($124)) + 2|0);
      $129 = HEAP8[$128>>0]|0;
      $130 = $129 << 24 >> 24;
      $131 = (($130) + -48)|0;
      $132 = (($4) + ($131<<2)|0);
      HEAP32[$132>>2] = 10;
      $133 = HEAP8[$128>>0]|0;
      $134 = $133 << 24 >> 24;
      $135 = (($134) + -48)|0;
      $136 = (($3) + ($135<<3)|0);
      $137 = $136;
      $138 = $137;
      $139 = HEAP32[$138>>2]|0;
      $140 = (($137) + 4)|0;
      $141 = $140;
      $142 = HEAP32[$141>>2]|0;
      $143 = ((($124)) + 4|0);
      HEAP32[$7>>2] = $143;
      $$0256 = $139;$$pre365 = $143;
      break;
     }
    }
    $144 = ($$3274|0)==(0);
    if (!($144)) {
     $$0 = -1;
     break L1;
    }
    if ($12) {
     $arglist_current2 = HEAP32[$2>>2]|0;
     $145 = $arglist_current2;
     $146 = ((0) + 4|0);
     $expanded11 = $146;
     $expanded10 = (($expanded11) - 1)|0;
     $147 = (($145) + ($expanded10))|0;
     $148 = ((0) + 4|0);
     $expanded15 = $148;
     $expanded14 = (($expanded15) - 1)|0;
     $expanded13 = $expanded14 ^ -1;
     $149 = $147 & $expanded13;
     $150 = $149;
     $151 = HEAP32[$150>>2]|0;
     $arglist_next3 = ((($150)) + 4|0);
     HEAP32[$2>>2] = $arglist_next3;
     $368 = $151;
    } else {
     $368 = 0;
    }
    $152 = HEAP32[$7>>2]|0;
    $153 = ((($152)) + 2|0);
    HEAP32[$7>>2] = $153;
    $$0256 = $368;$$pre365 = $153;
   } else {
    $$0256 = -1;$$pre365 = $114;
   }
  } while(0);
  $$0254 = 0;$156 = $$pre365;
  while(1) {
   $155 = HEAP8[$156>>0]|0;
   $157 = $155 << 24 >> 24;
   $158 = (($157) + -65)|0;
   $159 = ($158>>>0)>(57);
   if ($159) {
    $$0 = -1;
    break L1;
   }
   $160 = ((($156)) + 1|0);
   HEAP32[$7>>2] = $160;
   $161 = HEAP8[$156>>0]|0;
   $162 = $161 << 24 >> 24;
   $163 = (($162) + -65)|0;
   $164 = ((4736 + (($$0254*58)|0)|0) + ($163)|0);
   $165 = HEAP8[$164>>0]|0;
   $166 = $165&255;
   $167 = (($166) + -1)|0;
   $168 = ($167>>>0)<(8);
   if ($168) {
    $$0254 = $166;$156 = $160;
   } else {
    break;
   }
  }
  $169 = ($165<<24>>24)==(0);
  if ($169) {
   $$0 = -1;
   break;
  }
  $170 = ($165<<24>>24)==(19);
  $171 = ($$0255|0)>(-1);
  do {
   if ($170) {
    if ($171) {
     $$0 = -1;
     break L1;
    } else {
     label = 54;
    }
   } else {
    if ($171) {
     $172 = (($4) + ($$0255<<2)|0);
     HEAP32[$172>>2] = $166;
     $173 = (($3) + ($$0255<<3)|0);
     $174 = $173;
     $175 = $174;
     $176 = HEAP32[$175>>2]|0;
     $177 = (($174) + 4)|0;
     $178 = $177;
     $179 = HEAP32[$178>>2]|0;
     $180 = $8;
     $181 = $180;
     HEAP32[$181>>2] = $176;
     $182 = (($180) + 4)|0;
     $183 = $182;
     HEAP32[$183>>2] = $179;
     label = 54;
     break;
    }
    if (!($12)) {
     $$0 = 0;
     break L1;
    }
    _pop_arg_656($8,$166,$2,$6);
    $$pre366 = HEAP32[$7>>2]|0;
    $185 = $$pre366;
    label = 55;
   }
  } while(0);
  if ((label|0) == 54) {
   label = 0;
   if ($12) {
    $185 = $160;
    label = 55;
   } else {
    $$0245$ph$be = 0;
   }
  }
  L77: do {
   if ((label|0) == 55) {
    label = 0;
    $184 = ((($185)) + -1|0);
    $186 = HEAP8[$184>>0]|0;
    $187 = $186 << 24 >> 24;
    $188 = ($$0254|0)!=(0);
    $189 = $187 & 15;
    $190 = ($189|0)==(3);
    $or$cond278 = $188 & $190;
    $191 = $187 & -33;
    $$0237 = $or$cond278 ? $191 : $187;
    $192 = $$1265 & 8192;
    $193 = ($192|0)==(0);
    $194 = $$1265 & -65537;
    $spec$select = $193 ? $$1265 : $194;
    L79: do {
     switch ($$0237|0) {
     case 110:  {
      $trunc = $$0254&255;
      switch ($trunc<<24>>24) {
      case 0:  {
       $201 = HEAP32[$8>>2]|0;
       HEAP32[$201>>2] = $$1250;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      case 1:  {
       $202 = HEAP32[$8>>2]|0;
       HEAP32[$202>>2] = $$1250;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      case 2:  {
       $203 = ($$1250|0)<(0);
       $204 = $203 << 31 >> 31;
       $205 = HEAP32[$8>>2]|0;
       $206 = $205;
       $207 = $206;
       HEAP32[$207>>2] = $$1250;
       $208 = (($206) + 4)|0;
       $209 = $208;
       HEAP32[$209>>2] = $204;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      case 3:  {
       $210 = $$1250&65535;
       $211 = HEAP32[$8>>2]|0;
       HEAP16[$211>>1] = $210;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      case 4:  {
       $212 = $$1250&255;
       $213 = HEAP32[$8>>2]|0;
       HEAP8[$213>>0] = $212;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      case 6:  {
       $214 = HEAP32[$8>>2]|0;
       HEAP32[$214>>2] = $$1250;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      case 7:  {
       $215 = ($$1250|0)<(0);
       $216 = $215 << 31 >> 31;
       $217 = HEAP32[$8>>2]|0;
       $218 = $217;
       $219 = $218;
       HEAP32[$219>>2] = $$1250;
       $220 = (($218) + 4)|0;
       $221 = $220;
       HEAP32[$221>>2] = $216;
       $$0245$ph$be = 0;
       break L77;
       break;
      }
      default: {
       $$0245$ph$be = 0;
       break L77;
      }
      }
      break;
     }
     case 112:  {
      $222 = ($$0256>>>0)>(8);
      $223 = $222 ? $$0256 : 8;
      $224 = $spec$select | 8;
      $$1238 = 120;$$1257 = $223;$$3267 = $224;
      label = 67;
      break;
     }
     case 88: case 120:  {
      $$1238 = $$0237;$$1257 = $$0256;$$3267 = $spec$select;
      label = 67;
      break;
     }
     case 111:  {
      $246 = $8;
      $247 = $246;
      $248 = HEAP32[$247>>2]|0;
      $249 = (($246) + 4)|0;
      $250 = $249;
      $251 = HEAP32[$250>>2]|0;
      $252 = (_fmt_o($248,$251,$13)|0);
      $253 = $spec$select & 8;
      $254 = ($253|0)==(0);
      $255 = $252;
      $256 = (($14) - ($255))|0;
      $257 = ($$0256|0)>($256|0);
      $258 = (($256) + 1)|0;
      $259 = $254 | $257;
      $spec$select297 = $259 ? $$0256 : $258;
      $$0231 = $252;$$1235 = 0;$$1240 = 8132;$$2258 = $spec$select297;$$4268 = $spec$select;
      label = 73;
      break;
     }
     case 105: case 100:  {
      $260 = $8;
      $261 = $260;
      $262 = HEAP32[$261>>2]|0;
      $263 = (($260) + 4)|0;
      $264 = $263;
      $265 = HEAP32[$264>>2]|0;
      $266 = ($265|0)<(0);
      if ($266) {
       $267 = (_i64Subtract(0,0,($262|0),($265|0))|0);
       $268 = (getTempRet0() | 0);
       $269 = $8;
       $270 = $269;
       HEAP32[$270>>2] = $267;
       $271 = (($269) + 4)|0;
       $272 = $271;
       HEAP32[$272>>2] = $268;
       $$0234 = 1;$$0239 = 8132;$279 = $267;$280 = $268;
       label = 72;
       break L79;
      } else {
       $273 = $spec$select & 2048;
       $274 = ($273|0)==(0);
       $275 = $spec$select & 1;
       $276 = ($275|0)==(0);
       $$ = $276 ? 8132 : (8134);
       $spec$select298 = $274 ? $$ : (8133);
       $277 = $spec$select & 2049;
       $278 = ($277|0)!=(0);
       $spec$select299 = $278&1;
       $$0234 = $spec$select299;$$0239 = $spec$select298;$279 = $262;$280 = $265;
       label = 72;
       break L79;
      }
      break;
     }
     case 117:  {
      $195 = $8;
      $196 = $195;
      $197 = HEAP32[$196>>2]|0;
      $198 = (($195) + 4)|0;
      $199 = $198;
      $200 = HEAP32[$199>>2]|0;
      $$0234 = 0;$$0239 = 8132;$279 = $197;$280 = $200;
      label = 72;
      break;
     }
     case 99:  {
      $300 = $8;
      $301 = $300;
      $302 = HEAP32[$301>>2]|0;
      $303 = (($300) + 4)|0;
      $304 = $303;
      $305 = HEAP32[$304>>2]|0;
      $306 = $302&255;
      HEAP8[$15>>0] = $306;
      $$1 = $15;$$2236 = 0;$$2241 = 8132;$$5 = 1;$$6270 = $194;$$pre$phiZ2D = $14;
      break;
     }
     case 115:  {
      $307 = HEAP32[$8>>2]|0;
      $308 = ($307|0)==(0|0);
      $309 = $308 ? 8142 : $307;
      $310 = (_memchr($309,0,$$0256)|0);
      $311 = ($310|0)==(0|0);
      $312 = $310;
      $313 = $309;
      $314 = (($312) - ($313))|0;
      $315 = (($309) + ($$0256)|0);
      $$3259 = $311 ? $$0256 : $314;
      $$1252 = $311 ? $315 : $310;
      $$pre370 = $$1252;
      $$1 = $309;$$2236 = 0;$$2241 = 8132;$$5 = $$3259;$$6270 = $194;$$pre$phiZ2D = $$pre370;
      break;
     }
     case 67:  {
      $316 = $8;
      $317 = $316;
      $318 = HEAP32[$317>>2]|0;
      $319 = (($316) + 4)|0;
      $320 = $319;
      $321 = HEAP32[$320>>2]|0;
      HEAP32[$10>>2] = $318;
      HEAP32[$16>>2] = 0;
      HEAP32[$8>>2] = $10;
      $$4260372 = -1;
      label = 79;
      break;
     }
     case 83:  {
      $322 = ($$0256|0)==(0);
      if ($322) {
       _pad_659($0,32,$$1262,0,$spec$select);
       $$0242315373 = 0;
       label = 89;
      } else {
       $$4260372 = $$0256;
       label = 79;
      }
      break;
     }
     case 65: case 71: case 70: case 69: case 97: case 103: case 102: case 101:  {
      $345 = +HEAPF64[$8>>3];
      $346 = (FUNCTION_TABLE_iidiiii[$5 & 7]($0,$345,$$1262,$$0256,$spec$select,$$0237)|0);
      $$0245$ph$be = $346;
      break L77;
      break;
     }
     default: {
      $$1 = $22;$$2236 = 0;$$2241 = 8132;$$5 = $$0256;$$6270 = $spec$select;$$pre$phiZ2D = $14;
     }
     }
    } while(0);
    L102: do {
     if ((label|0) == 67) {
      label = 0;
      $225 = $8;
      $226 = $225;
      $227 = HEAP32[$226>>2]|0;
      $228 = (($225) + 4)|0;
      $229 = $228;
      $230 = HEAP32[$229>>2]|0;
      $231 = $$1238 & 32;
      $232 = (_fmt_x($227,$230,$13,$231)|0);
      $233 = $8;
      $234 = $233;
      $235 = HEAP32[$234>>2]|0;
      $236 = (($233) + 4)|0;
      $237 = $236;
      $238 = HEAP32[$237>>2]|0;
      $239 = ($235|0)==(0);
      $240 = ($238|0)==(0);
      $241 = $239 & $240;
      $242 = $$3267 & 8;
      $243 = ($242|0)==(0);
      $or$cond280 = $243 | $241;
      $244 = $$1238 >>> 4;
      $245 = (8132 + ($244)|0);
      $spec$select295 = $or$cond280 ? 8132 : $245;
      $spec$select296 = $or$cond280 ? 0 : 2;
      $$0231 = $232;$$1235 = $spec$select296;$$1240 = $spec$select295;$$2258 = $$1257;$$4268 = $$3267;
      label = 73;
     }
     else if ((label|0) == 72) {
      label = 0;
      $281 = (_fmt_u($279,$280,$13)|0);
      $$0231 = $281;$$1235 = $$0234;$$1240 = $$0239;$$2258 = $$0256;$$4268 = $spec$select;
      label = 73;
     }
     else if ((label|0) == 79) {
      label = 0;
      $323 = HEAP32[$8>>2]|0;
      $$0232336 = $323;$$0242335 = 0;
      while(1) {
       $324 = HEAP32[$$0232336>>2]|0;
       $325 = ($324|0)==(0);
       if ($325) {
        $$0242315 = $$0242335;
        break;
       }
       $326 = (_wctomb($11,$324)|0);
       $327 = ($326|0)<(0);
       $328 = (($$4260372) - ($$0242335))|0;
       $329 = ($326>>>0)>($328>>>0);
       $or$cond285 = $327 | $329;
       if ($or$cond285) {
        label = 83;
        break;
       }
       $330 = ((($$0232336)) + 4|0);
       $331 = (($326) + ($$0242335))|0;
       $332 = ($$4260372>>>0)>($331>>>0);
       if ($332) {
        $$0232336 = $330;$$0242335 = $331;
       } else {
        $$0242315 = $331;
        break;
       }
      }
      if ((label|0) == 83) {
       label = 0;
       if ($327) {
        $$0 = -1;
        break L1;
       } else {
        $$0242315 = $$0242335;
       }
      }
      _pad_659($0,32,$$1262,$$0242315,$spec$select);
      $333 = ($$0242315|0)==(0);
      if ($333) {
       $$0242315373 = 0;
       label = 89;
      } else {
       $334 = HEAP32[$8>>2]|0;
       $$1233342 = $334;$$1243341 = 0;
       while(1) {
        $335 = HEAP32[$$1233342>>2]|0;
        $336 = ($335|0)==(0);
        if ($336) {
         $$0242315373 = $$0242315;
         label = 89;
         break L102;
        }
        $337 = (_wctomb($11,$335)|0);
        $338 = (($337) + ($$1243341))|0;
        $339 = ($338|0)>($$0242315|0);
        if ($339) {
         $$0242315373 = $$0242315;
         label = 89;
         break L102;
        }
        $340 = ((($$1233342)) + 4|0);
        _out_653($0,$11,$337);
        $341 = ($338>>>0)<($$0242315>>>0);
        if ($341) {
         $$1233342 = $340;$$1243341 = $338;
        } else {
         $$0242315373 = $$0242315;
         label = 89;
         break;
        }
       }
      }
     }
    } while(0);
    if ((label|0) == 73) {
     label = 0;
     $282 = ($$2258|0)>(-1);
     $283 = $$4268 & -65537;
     $spec$select283 = $282 ? $283 : $$4268;
     $284 = $8;
     $285 = $284;
     $286 = HEAP32[$285>>2]|0;
     $287 = (($284) + 4)|0;
     $288 = $287;
     $289 = HEAP32[$288>>2]|0;
     $290 = ($286|0)!=(0);
     $291 = ($289|0)!=(0);
     $292 = $290 | $291;
     $293 = ($$2258|0)!=(0);
     $or$cond = $293 | $292;
     $294 = $$0231;
     $295 = (($14) - ($294))|0;
     $296 = $292 ^ 1;
     $297 = $296&1;
     $298 = (($295) + ($297))|0;
     $299 = ($$2258|0)>($298|0);
     $$2258$ = $299 ? $$2258 : $298;
     $spec$select300 = $or$cond ? $$2258$ : 0;
     $spec$select301 = $or$cond ? $$0231 : $13;
     $$1 = $spec$select301;$$2236 = $$1235;$$2241 = $$1240;$$5 = $spec$select300;$$6270 = $spec$select283;$$pre$phiZ2D = $14;
    }
    else if ((label|0) == 89) {
     label = 0;
     $342 = $spec$select ^ 8192;
     _pad_659($0,32,$$1262,$$0242315373,$342);
     $343 = ($$1262|0)>($$0242315373|0);
     $344 = $343 ? $$1262 : $$0242315373;
     $$0245$ph$be = $344;
     break;
    }
    $347 = $$1;
    $348 = (($$pre$phiZ2D) - ($347))|0;
    $349 = ($$5|0)<($348|0);
    $spec$select286 = $349 ? $348 : $$5;
    $350 = (($spec$select286) + ($$2236))|0;
    $351 = ($$1262|0)<($350|0);
    $$2263 = $351 ? $350 : $$1262;
    _pad_659($0,32,$$2263,$350,$$6270);
    _out_653($0,$$2241,$$2236);
    $352 = $$6270 ^ 65536;
    _pad_659($0,48,$$2263,$350,$352);
    _pad_659($0,48,$spec$select286,$348,0);
    _out_653($0,$$1,$348);
    $353 = $$6270 ^ 8192;
    _pad_659($0,32,$$2263,$350,$353);
    $$0245$ph$be = $$2263;
   }
  } while(0);
  $$0245$ph = $$0245$ph$be;$$0249$ph = $$1250;$$0271$ph = $$3274;
 }
 L123: do {
  if ((label|0) == 92) {
   $354 = ($0|0)==(0|0);
   if ($354) {
    $355 = ($$0271$ph|0)==(0);
    if ($355) {
     $$0 = 0;
    } else {
     $$2244322 = 1;
     while(1) {
      $356 = (($4) + ($$2244322<<2)|0);
      $357 = HEAP32[$356>>2]|0;
      $358 = ($357|0)==(0);
      if ($358) {
       break;
      }
      $359 = (($3) + ($$2244322<<3)|0);
      _pop_arg_656($359,$357,$2,$6);
      $360 = (($$2244322) + 1)|0;
      $361 = ($360>>>0)<(10);
      if ($361) {
       $$2244322 = $360;
      } else {
       $$0 = 1;
       break L123;
      }
     }
     $$3319 = $$2244322;
     while(1) {
      $364 = (($4) + ($$3319<<2)|0);
      $365 = HEAP32[$364>>2]|0;
      $366 = ($365|0)==(0);
      $363 = (($$3319) + 1)|0;
      if (!($366)) {
       $$0 = -1;
       break L123;
      }
      $362 = ($363>>>0)<(10);
      if ($362) {
       $$3319 = $363;
      } else {
       $$0 = 1;
       break;
      }
     }
    }
   } else {
    $$0 = $$1250;
   }
  }
 } while(0);
 STACKTOP = sp;return ($$0|0);
}
function _out_653($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $3 = 0, $4 = 0, $5 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = HEAP32[$0>>2]|0;
 $4 = $3 & 32;
 $5 = ($4|0)==(0);
 if ($5) {
  (___fwritex($1,$2,$0)|0);
 }
 return;
}
function _getint_654($0) {
 $0 = $0|0;
 var $$0$lcssa = 0, $$04 = 0, $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = HEAP32[$0>>2]|0;
 $2 = HEAP8[$1>>0]|0;
 $3 = $2 << 24 >> 24;
 $4 = (_isdigit($3)|0);
 $5 = ($4|0)==(0);
 if ($5) {
  $$0$lcssa = 0;
 } else {
  $$04 = 0;
  while(1) {
   $6 = ($$04*10)|0;
   $7 = HEAP32[$0>>2]|0;
   $8 = HEAP8[$7>>0]|0;
   $9 = $8 << 24 >> 24;
   $10 = (($6) + -48)|0;
   $11 = (($10) + ($9))|0;
   $12 = ((($7)) + 1|0);
   HEAP32[$0>>2] = $12;
   $13 = HEAP8[$12>>0]|0;
   $14 = $13 << 24 >> 24;
   $15 = (_isdigit($14)|0);
   $16 = ($15|0)==(0);
   if ($16) {
    $$0$lcssa = $11;
    break;
   } else {
    $$04 = $11;
   }
  }
 }
 return ($$0$lcssa|0);
}
function _pop_arg_656($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$mask = 0, $$mask31 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0.0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0;
 var $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0;
 var $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0;
 var $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0;
 var $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0;
 var $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $arglist_current = 0, $arglist_current11 = 0, $arglist_current14 = 0, $arglist_current17 = 0, $arglist_current2 = 0, $arglist_current20 = 0, $arglist_current23 = 0, $arglist_current5 = 0, $arglist_current8 = 0, $arglist_next = 0, $arglist_next12 = 0;
 var $arglist_next15 = 0, $arglist_next18 = 0, $arglist_next21 = 0, $arglist_next24 = 0, $arglist_next3 = 0, $arglist_next6 = 0, $arglist_next9 = 0, $expanded = 0, $expanded25 = 0, $expanded27 = 0, $expanded28 = 0, $expanded29 = 0, $expanded31 = 0, $expanded32 = 0, $expanded34 = 0, $expanded35 = 0, $expanded36 = 0, $expanded38 = 0, $expanded39 = 0, $expanded41 = 0;
 var $expanded42 = 0, $expanded43 = 0, $expanded45 = 0, $expanded46 = 0, $expanded48 = 0, $expanded49 = 0, $expanded50 = 0, $expanded52 = 0, $expanded53 = 0, $expanded55 = 0, $expanded56 = 0, $expanded57 = 0, $expanded59 = 0, $expanded60 = 0, $expanded62 = 0, $expanded63 = 0, $expanded64 = 0, $expanded66 = 0, $expanded67 = 0, $expanded69 = 0;
 var $expanded70 = 0, $expanded71 = 0, $expanded73 = 0, $expanded74 = 0, $expanded76 = 0, $expanded77 = 0, $expanded78 = 0, $expanded80 = 0, $expanded81 = 0, $expanded83 = 0, $expanded84 = 0, $expanded85 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $4 = ($1>>>0)>(20);
 L1: do {
  if (!($4)) {
   do {
    switch ($1|0) {
    case 9:  {
     $arglist_current = HEAP32[$2>>2]|0;
     $5 = $arglist_current;
     $6 = ((0) + 4|0);
     $expanded25 = $6;
     $expanded = (($expanded25) - 1)|0;
     $7 = (($5) + ($expanded))|0;
     $8 = ((0) + 4|0);
     $expanded29 = $8;
     $expanded28 = (($expanded29) - 1)|0;
     $expanded27 = $expanded28 ^ -1;
     $9 = $7 & $expanded27;
     $10 = $9;
     $11 = HEAP32[$10>>2]|0;
     $arglist_next = ((($10)) + 4|0);
     HEAP32[$2>>2] = $arglist_next;
     HEAP32[$0>>2] = $11;
     break L1;
     break;
    }
    case 10:  {
     $arglist_current2 = HEAP32[$2>>2]|0;
     $12 = $arglist_current2;
     $13 = ((0) + 4|0);
     $expanded32 = $13;
     $expanded31 = (($expanded32) - 1)|0;
     $14 = (($12) + ($expanded31))|0;
     $15 = ((0) + 4|0);
     $expanded36 = $15;
     $expanded35 = (($expanded36) - 1)|0;
     $expanded34 = $expanded35 ^ -1;
     $16 = $14 & $expanded34;
     $17 = $16;
     $18 = HEAP32[$17>>2]|0;
     $arglist_next3 = ((($17)) + 4|0);
     HEAP32[$2>>2] = $arglist_next3;
     $19 = ($18|0)<(0);
     $20 = $19 << 31 >> 31;
     $21 = $0;
     $22 = $21;
     HEAP32[$22>>2] = $18;
     $23 = (($21) + 4)|0;
     $24 = $23;
     HEAP32[$24>>2] = $20;
     break L1;
     break;
    }
    case 11:  {
     $arglist_current5 = HEAP32[$2>>2]|0;
     $25 = $arglist_current5;
     $26 = ((0) + 4|0);
     $expanded39 = $26;
     $expanded38 = (($expanded39) - 1)|0;
     $27 = (($25) + ($expanded38))|0;
     $28 = ((0) + 4|0);
     $expanded43 = $28;
     $expanded42 = (($expanded43) - 1)|0;
     $expanded41 = $expanded42 ^ -1;
     $29 = $27 & $expanded41;
     $30 = $29;
     $31 = HEAP32[$30>>2]|0;
     $arglist_next6 = ((($30)) + 4|0);
     HEAP32[$2>>2] = $arglist_next6;
     $32 = $0;
     $33 = $32;
     HEAP32[$33>>2] = $31;
     $34 = (($32) + 4)|0;
     $35 = $34;
     HEAP32[$35>>2] = 0;
     break L1;
     break;
    }
    case 12:  {
     $arglist_current8 = HEAP32[$2>>2]|0;
     $36 = $arglist_current8;
     $37 = ((0) + 8|0);
     $expanded46 = $37;
     $expanded45 = (($expanded46) - 1)|0;
     $38 = (($36) + ($expanded45))|0;
     $39 = ((0) + 8|0);
     $expanded50 = $39;
     $expanded49 = (($expanded50) - 1)|0;
     $expanded48 = $expanded49 ^ -1;
     $40 = $38 & $expanded48;
     $41 = $40;
     $42 = $41;
     $43 = $42;
     $44 = HEAP32[$43>>2]|0;
     $45 = (($42) + 4)|0;
     $46 = $45;
     $47 = HEAP32[$46>>2]|0;
     $arglist_next9 = ((($41)) + 8|0);
     HEAP32[$2>>2] = $arglist_next9;
     $48 = $0;
     $49 = $48;
     HEAP32[$49>>2] = $44;
     $50 = (($48) + 4)|0;
     $51 = $50;
     HEAP32[$51>>2] = $47;
     break L1;
     break;
    }
    case 13:  {
     $arglist_current11 = HEAP32[$2>>2]|0;
     $52 = $arglist_current11;
     $53 = ((0) + 4|0);
     $expanded53 = $53;
     $expanded52 = (($expanded53) - 1)|0;
     $54 = (($52) + ($expanded52))|0;
     $55 = ((0) + 4|0);
     $expanded57 = $55;
     $expanded56 = (($expanded57) - 1)|0;
     $expanded55 = $expanded56 ^ -1;
     $56 = $54 & $expanded55;
     $57 = $56;
     $58 = HEAP32[$57>>2]|0;
     $arglist_next12 = ((($57)) + 4|0);
     HEAP32[$2>>2] = $arglist_next12;
     $59 = $58&65535;
     $60 = $59 << 16 >> 16;
     $61 = ($60|0)<(0);
     $62 = $61 << 31 >> 31;
     $63 = $0;
     $64 = $63;
     HEAP32[$64>>2] = $60;
     $65 = (($63) + 4)|0;
     $66 = $65;
     HEAP32[$66>>2] = $62;
     break L1;
     break;
    }
    case 14:  {
     $arglist_current14 = HEAP32[$2>>2]|0;
     $67 = $arglist_current14;
     $68 = ((0) + 4|0);
     $expanded60 = $68;
     $expanded59 = (($expanded60) - 1)|0;
     $69 = (($67) + ($expanded59))|0;
     $70 = ((0) + 4|0);
     $expanded64 = $70;
     $expanded63 = (($expanded64) - 1)|0;
     $expanded62 = $expanded63 ^ -1;
     $71 = $69 & $expanded62;
     $72 = $71;
     $73 = HEAP32[$72>>2]|0;
     $arglist_next15 = ((($72)) + 4|0);
     HEAP32[$2>>2] = $arglist_next15;
     $$mask31 = $73 & 65535;
     $74 = $0;
     $75 = $74;
     HEAP32[$75>>2] = $$mask31;
     $76 = (($74) + 4)|0;
     $77 = $76;
     HEAP32[$77>>2] = 0;
     break L1;
     break;
    }
    case 15:  {
     $arglist_current17 = HEAP32[$2>>2]|0;
     $78 = $arglist_current17;
     $79 = ((0) + 4|0);
     $expanded67 = $79;
     $expanded66 = (($expanded67) - 1)|0;
     $80 = (($78) + ($expanded66))|0;
     $81 = ((0) + 4|0);
     $expanded71 = $81;
     $expanded70 = (($expanded71) - 1)|0;
     $expanded69 = $expanded70 ^ -1;
     $82 = $80 & $expanded69;
     $83 = $82;
     $84 = HEAP32[$83>>2]|0;
     $arglist_next18 = ((($83)) + 4|0);
     HEAP32[$2>>2] = $arglist_next18;
     $85 = $84&255;
     $86 = $85 << 24 >> 24;
     $87 = ($86|0)<(0);
     $88 = $87 << 31 >> 31;
     $89 = $0;
     $90 = $89;
     HEAP32[$90>>2] = $86;
     $91 = (($89) + 4)|0;
     $92 = $91;
     HEAP32[$92>>2] = $88;
     break L1;
     break;
    }
    case 16:  {
     $arglist_current20 = HEAP32[$2>>2]|0;
     $93 = $arglist_current20;
     $94 = ((0) + 4|0);
     $expanded74 = $94;
     $expanded73 = (($expanded74) - 1)|0;
     $95 = (($93) + ($expanded73))|0;
     $96 = ((0) + 4|0);
     $expanded78 = $96;
     $expanded77 = (($expanded78) - 1)|0;
     $expanded76 = $expanded77 ^ -1;
     $97 = $95 & $expanded76;
     $98 = $97;
     $99 = HEAP32[$98>>2]|0;
     $arglist_next21 = ((($98)) + 4|0);
     HEAP32[$2>>2] = $arglist_next21;
     $$mask = $99 & 255;
     $100 = $0;
     $101 = $100;
     HEAP32[$101>>2] = $$mask;
     $102 = (($100) + 4)|0;
     $103 = $102;
     HEAP32[$103>>2] = 0;
     break L1;
     break;
    }
    case 17:  {
     $arglist_current23 = HEAP32[$2>>2]|0;
     $104 = $arglist_current23;
     $105 = ((0) + 8|0);
     $expanded81 = $105;
     $expanded80 = (($expanded81) - 1)|0;
     $106 = (($104) + ($expanded80))|0;
     $107 = ((0) + 8|0);
     $expanded85 = $107;
     $expanded84 = (($expanded85) - 1)|0;
     $expanded83 = $expanded84 ^ -1;
     $108 = $106 & $expanded83;
     $109 = $108;
     $110 = +HEAPF64[$109>>3];
     $arglist_next24 = ((($109)) + 8|0);
     HEAP32[$2>>2] = $arglist_next24;
     HEAPF64[$0>>3] = $110;
     break L1;
     break;
    }
    case 18:  {
     FUNCTION_TABLE_vii[$3 & 7]($0,$2);
     break L1;
     break;
    }
    default: {
     break L1;
    }
    }
   } while(0);
  }
 } while(0);
 return;
}
function _fmt_x($0,$1,$2,$3) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 var $$05$lcssa = 0, $$056 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 $4 = ($0|0)==(0);
 $5 = ($1|0)==(0);
 $6 = $4 & $5;
 if ($6) {
  $$05$lcssa = $2;
 } else {
  $$056 = $2;$15 = $1;$8 = $0;
  while(1) {
   $7 = $8 & 15;
   $9 = (5200 + ($7)|0);
   $10 = HEAP8[$9>>0]|0;
   $11 = $10&255;
   $12 = $11 | $3;
   $13 = $12&255;
   $14 = ((($$056)) + -1|0);
   HEAP8[$14>>0] = $13;
   $16 = (_bitshift64Lshr(($8|0),($15|0),4)|0);
   $17 = (getTempRet0() | 0);
   $18 = ($16|0)==(0);
   $19 = ($17|0)==(0);
   $20 = $18 & $19;
   if ($20) {
    $$05$lcssa = $14;
    break;
   } else {
    $$056 = $14;$15 = $17;$8 = $16;
   }
  }
 }
 return ($$05$lcssa|0);
}
function _fmt_o($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$0$lcssa = 0, $$06 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ($0|0)==(0);
 $4 = ($1|0)==(0);
 $5 = $3 & $4;
 if ($5) {
  $$0$lcssa = $2;
 } else {
  $$06 = $2;$11 = $1;$7 = $0;
  while(1) {
   $6 = $7&255;
   $8 = $6 & 7;
   $9 = $8 | 48;
   $10 = ((($$06)) + -1|0);
   HEAP8[$10>>0] = $9;
   $12 = (_bitshift64Lshr(($7|0),($11|0),3)|0);
   $13 = (getTempRet0() | 0);
   $14 = ($12|0)==(0);
   $15 = ($13|0)==(0);
   $16 = $14 & $15;
   if ($16) {
    $$0$lcssa = $10;
    break;
   } else {
    $$06 = $10;$11 = $13;$7 = $12;
   }
  }
 }
 return ($$0$lcssa|0);
}
function _fmt_u($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$010$lcssa$off0 = 0, $$012 = 0, $$09$lcssa = 0, $$0914 = 0, $$1$lcssa = 0, $$111 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0;
 var $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ($1>>>0)>(0);
 $4 = ($0>>>0)>(4294967295);
 $5 = ($1|0)==(0);
 $6 = $5 & $4;
 $7 = $3 | $6;
 if ($7) {
  $$0914 = $2;$8 = $0;$9 = $1;
  while(1) {
   $10 = (___udivdi3(($8|0),($9|0),10,0)|0);
   $11 = (getTempRet0() | 0);
   $12 = (___muldi3(($10|0),($11|0),10,0)|0);
   $13 = (getTempRet0() | 0);
   $14 = (_i64Subtract(($8|0),($9|0),($12|0),($13|0))|0);
   $15 = (getTempRet0() | 0);
   $16 = $14&255;
   $17 = $16 | 48;
   $18 = ((($$0914)) + -1|0);
   HEAP8[$18>>0] = $17;
   $19 = ($9>>>0)>(9);
   $20 = ($8>>>0)>(4294967295);
   $21 = ($9|0)==(9);
   $22 = $21 & $20;
   $23 = $19 | $22;
   if ($23) {
    $$0914 = $18;$8 = $10;$9 = $11;
   } else {
    break;
   }
  }
  $$010$lcssa$off0 = $10;$$09$lcssa = $18;
 } else {
  $$010$lcssa$off0 = $0;$$09$lcssa = $2;
 }
 $24 = ($$010$lcssa$off0|0)==(0);
 if ($24) {
  $$1$lcssa = $$09$lcssa;
 } else {
  $$012 = $$010$lcssa$off0;$$111 = $$09$lcssa;
  while(1) {
   $25 = (($$012>>>0) / 10)&-1;
   $26 = ($25*10)|0;
   $27 = (($$012) - ($26))|0;
   $28 = $27 | 48;
   $29 = $28&255;
   $30 = ((($$111)) + -1|0);
   HEAP8[$30>>0] = $29;
   $31 = ($$012>>>0)<(10);
   if ($31) {
    $$1$lcssa = $30;
    break;
   } else {
    $$012 = $25;$$111 = $30;
   }
  }
 }
 return ($$1$lcssa|0);
}
function _pad_659($0,$1,$2,$3,$4) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 $3 = $3|0;
 $4 = $4|0;
 var $$0$lcssa = 0, $$011 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $or$cond = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 256|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(256|0);
 $5 = sp;
 $6 = $4 & 73728;
 $7 = ($6|0)==(0);
 $8 = ($2|0)>($3|0);
 $or$cond = $8 & $7;
 if ($or$cond) {
  $9 = (($2) - ($3))|0;
  $10 = $1 << 24 >> 24;
  $11 = ($9>>>0)<(256);
  $12 = $11 ? $9 : 256;
  (_memset(($5|0),($10|0),($12|0))|0);
  $13 = ($9>>>0)>(255);
  if ($13) {
   $14 = (($2) - ($3))|0;
   $$011 = $9;
   while(1) {
    _out_653($0,$5,256);
    $15 = (($$011) + -256)|0;
    $16 = ($15>>>0)>(255);
    if ($16) {
     $$011 = $15;
    } else {
     break;
    }
   }
   $17 = $14 & 255;
   $$0$lcssa = $17;
  } else {
   $$0$lcssa = $9;
  }
  _out_653($0,$5,$$0$lcssa);
 }
 STACKTOP = sp;return;
}
function _wctomb($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $2 = 0, $3 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($0|0)==(0|0);
 if ($2) {
  $$0 = 0;
 } else {
  $3 = (_wcrtomb($0,$1,0)|0);
  $$0 = $3;
 }
 return ($$0|0);
}
function _wcrtomb($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0;
 var $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0;
 var $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $or$cond = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $3 = ($0|0)==(0|0);
 do {
  if ($3) {
   $$0 = 1;
  } else {
   $4 = ($1>>>0)<(128);
   if ($4) {
    $5 = $1&255;
    HEAP8[$0>>0] = $5;
    $$0 = 1;
    break;
   }
   $6 = (___pthread_self_896()|0);
   $7 = ((($6)) + 188|0);
   $8 = HEAP32[$7>>2]|0;
   $9 = HEAP32[$8>>2]|0;
   $10 = ($9|0)==(0|0);
   if ($10) {
    $11 = $1 & -128;
    $12 = ($11|0)==(57216);
    if ($12) {
     $14 = $1&255;
     HEAP8[$0>>0] = $14;
     $$0 = 1;
     break;
    } else {
     $13 = (___errno_location()|0);
     HEAP32[$13>>2] = 84;
     $$0 = -1;
     break;
    }
   }
   $15 = ($1>>>0)<(2048);
   if ($15) {
    $16 = $1 >>> 6;
    $17 = $16 | 192;
    $18 = $17&255;
    $19 = ((($0)) + 1|0);
    HEAP8[$0>>0] = $18;
    $20 = $1 & 63;
    $21 = $20 | 128;
    $22 = $21&255;
    HEAP8[$19>>0] = $22;
    $$0 = 2;
    break;
   }
   $23 = ($1>>>0)<(55296);
   $24 = $1 & -8192;
   $25 = ($24|0)==(57344);
   $or$cond = $23 | $25;
   if ($or$cond) {
    $26 = $1 >>> 12;
    $27 = $26 | 224;
    $28 = $27&255;
    $29 = ((($0)) + 1|0);
    HEAP8[$0>>0] = $28;
    $30 = $1 >>> 6;
    $31 = $30 & 63;
    $32 = $31 | 128;
    $33 = $32&255;
    $34 = ((($0)) + 2|0);
    HEAP8[$29>>0] = $33;
    $35 = $1 & 63;
    $36 = $35 | 128;
    $37 = $36&255;
    HEAP8[$34>>0] = $37;
    $$0 = 3;
    break;
   }
   $38 = (($1) + -65536)|0;
   $39 = ($38>>>0)<(1048576);
   if ($39) {
    $40 = $1 >>> 18;
    $41 = $40 | 240;
    $42 = $41&255;
    $43 = ((($0)) + 1|0);
    HEAP8[$0>>0] = $42;
    $44 = $1 >>> 12;
    $45 = $44 & 63;
    $46 = $45 | 128;
    $47 = $46&255;
    $48 = ((($0)) + 2|0);
    HEAP8[$43>>0] = $47;
    $49 = $1 >>> 6;
    $50 = $49 & 63;
    $51 = $50 | 128;
    $52 = $51&255;
    $53 = ((($0)) + 3|0);
    HEAP8[$48>>0] = $52;
    $54 = $1 & 63;
    $55 = $54 | 128;
    $56 = $55&255;
    HEAP8[$53>>0] = $56;
    $$0 = 4;
    break;
   } else {
    $57 = (___errno_location()|0);
    HEAP32[$57>>2] = 84;
    $$0 = -1;
    break;
   }
  }
 } while(0);
 return ($$0|0);
}
function ___pthread_self_896() {
 var $0 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $0 = (_pthread_self()|0);
 return ($0|0);
}
function ___DOUBLE_BITS_662($0) {
 $0 = +$0;
 var $1 = 0, $2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 HEAPF64[tempDoublePtr>>3] = $0;$1 = HEAP32[tempDoublePtr>>2]|0;
 $2 = HEAP32[tempDoublePtr+4>>2]|0;
 setTempRet0(($2) | 0);
 return ($1|0);
}
function _frexp($0,$1) {
 $0 = +$0;
 $1 = $1|0;
 var $$0 = 0.0, $$016 = 0.0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0.0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0.0, $9 = 0.0, $storemerge = 0, $trunc$clear = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 HEAPF64[tempDoublePtr>>3] = $0;$2 = HEAP32[tempDoublePtr>>2]|0;
 $3 = HEAP32[tempDoublePtr+4>>2]|0;
 $4 = (_bitshift64Lshr(($2|0),($3|0),52)|0);
 $5 = (getTempRet0() | 0);
 $6 = $4&65535;
 $trunc$clear = $6 & 2047;
 switch ($trunc$clear<<16>>16) {
 case 0:  {
  $7 = $0 != 0.0;
  if ($7) {
   $8 = $0 * 1.8446744073709552E+19;
   $9 = (+_frexp($8,$1));
   $10 = HEAP32[$1>>2]|0;
   $11 = (($10) + -64)|0;
   $$016 = $9;$storemerge = $11;
  } else {
   $$016 = $0;$storemerge = 0;
  }
  HEAP32[$1>>2] = $storemerge;
  $$0 = $$016;
  break;
 }
 case 2047:  {
  $$0 = $0;
  break;
 }
 default: {
  $12 = $4 & 2047;
  $13 = (($12) + -1022)|0;
  HEAP32[$1>>2] = $13;
  $14 = $3 & -2146435073;
  $15 = $14 | 1071644672;
  HEAP32[tempDoublePtr>>2] = $2;HEAP32[tempDoublePtr+4>>2] = $15;$16 = +HEAPF64[tempDoublePtr>>3];
  $$0 = $16;
 }
 }
 return (+$$0);
}
function _open($0,$1,$varargs) {
 $0 = $0|0;
 $1 = $1|0;
 $varargs = $varargs|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $arglist_current = 0, $arglist_next = 0;
 var $expanded = 0, $expanded2 = 0, $expanded4 = 0, $expanded5 = 0, $expanded6 = 0, $or$cond14 = 0, $vararg_buffer = 0, $vararg_buffer3 = 0, $vararg_ptr1 = 0, $vararg_ptr2 = 0, $vararg_ptr6 = 0, $vararg_ptr7 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 48|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(48|0);
 $vararg_buffer3 = sp + 32|0;
 $vararg_buffer = sp + 16|0;
 $2 = sp;
 $3 = $1 & 4194368;
 $4 = ($3|0)==(0);
 if ($4) {
  $$0 = 0;
 } else {
  HEAP32[$2>>2] = $varargs;
  $arglist_current = HEAP32[$2>>2]|0;
  $5 = $arglist_current;
  $6 = ((0) + 4|0);
  $expanded2 = $6;
  $expanded = (($expanded2) - 1)|0;
  $7 = (($5) + ($expanded))|0;
  $8 = ((0) + 4|0);
  $expanded6 = $8;
  $expanded5 = (($expanded6) - 1)|0;
  $expanded4 = $expanded5 ^ -1;
  $9 = $7 & $expanded4;
  $10 = $9;
  $11 = HEAP32[$10>>2]|0;
  $arglist_next = ((($10)) + 4|0);
  HEAP32[$2>>2] = $arglist_next;
  $$0 = $11;
 }
 $12 = $0;
 $13 = $1 | 32768;
 HEAP32[$vararg_buffer>>2] = $12;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $13;
 $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
 HEAP32[$vararg_ptr2>>2] = $$0;
 $14 = (___syscall5(5,($vararg_buffer|0))|0);
 $15 = ($14|0)<(0);
 $16 = $1 & 524288;
 $17 = ($16|0)==(0);
 $or$cond14 = $17 | $15;
 if (!($or$cond14)) {
  HEAP32[$vararg_buffer3>>2] = $14;
  $vararg_ptr6 = ((($vararg_buffer3)) + 4|0);
  HEAP32[$vararg_ptr6>>2] = 2;
  $vararg_ptr7 = ((($vararg_buffer3)) + 8|0);
  HEAP32[$vararg_ptr7>>2] = 1;
  (___syscall221(221,($vararg_buffer3|0))|0);
 }
 $18 = (___syscall_ret($14)|0);
 STACKTOP = sp;return ($18|0);
}
function _close($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $spec$store$select = 0, $vararg_buffer = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $1 = (_dummy($0)|0);
 HEAP32[$vararg_buffer>>2] = $1;
 $2 = (___syscall6(6,($vararg_buffer|0))|0);
 $3 = ($2|0)==(-4);
 $spec$store$select = $3 ? 0 : $2;
 $4 = (___syscall_ret($spec$store$select)|0);
 STACKTOP = sp;return ($4|0);
}
function ___procfdname($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$02324 = 0, $$027 = 0, $$126 = 0, $$225 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, dest = 0;
 var label = 0, sp = 0, src = 0, stop = 0;
 sp = STACKTOP;
 dest=$0; src=8186; stop=dest+15|0; do { HEAP8[dest>>0]=HEAP8[src>>0]|0; dest=dest+1|0; src=src+1|0; } while ((dest|0) < (stop|0));
 $2 = ($1|0)==(0);
 if ($2) {
  $3 = ((($0)) + 14|0);
  HEAP8[$3>>0] = 48;
  $4 = ((($0)) + 15|0);
  HEAP8[$4>>0] = 0;
 } else {
  $$027 = $1;$$126 = 14;
  while(1) {
   $5 = (($$027>>>0) / 10)&-1;
   $6 = (($$126) + 1)|0;
   $7 = ($$027>>>0)<(10);
   if ($7) {
    break;
   } else {
    $$027 = $5;$$126 = $6;
   }
  }
  $8 = (($0) + ($6)|0);
  HEAP8[$8>>0] = 0;
  $$02324 = $1;$$225 = $6;
  while(1) {
   $9 = (($$02324>>>0) / 10)&-1;
   $10 = ($9*10)|0;
   $11 = (($$02324) - ($10))|0;
   $12 = $11 | 48;
   $13 = $12&255;
   $14 = (($$225) + -1)|0;
   $15 = (($0) + ($14)|0);
   HEAP8[$15>>0] = $13;
   $16 = ($$02324>>>0)<(10);
   if ($16) {
    break;
   } else {
    $$02324 = $9;$$225 = $14;
   }
  }
 }
 return;
}
function _fstat($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $10 = 0, $11 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $vararg_buffer = 0, $vararg_buffer2 = 0, $vararg_buffer6 = 0, $vararg_ptr1 = 0, $vararg_ptr5 = 0, $vararg_ptr9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 64|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(64|0);
 $vararg_buffer6 = sp + 48|0;
 $vararg_buffer2 = sp + 40|0;
 $vararg_buffer = sp + 32|0;
 $2 = sp;
 $3 = $1;
 HEAP32[$vararg_buffer>>2] = $0;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $3;
 $4 = (___syscall197(197,($vararg_buffer|0))|0);
 $5 = ($4|0)==(-9);
 if ($5) {
  HEAP32[$vararg_buffer2>>2] = $0;
  $vararg_ptr5 = ((($vararg_buffer2)) + 4|0);
  HEAP32[$vararg_ptr5>>2] = 1;
  $6 = (___syscall221(221,($vararg_buffer2|0))|0);
  $7 = ($6|0)<(0);
  if ($7) {
   label = 3;
  } else {
   ___procfdname($2,$0);
   $9 = $2;
   HEAP32[$vararg_buffer6>>2] = $9;
   $vararg_ptr9 = ((($vararg_buffer6)) + 4|0);
   HEAP32[$vararg_ptr9>>2] = $3;
   $10 = (___syscall195(195,($vararg_buffer6|0))|0);
   $11 = (___syscall_ret($10)|0);
   $$0 = $11;
  }
 } else {
  label = 3;
 }
 if ((label|0) == 3) {
  $8 = (___syscall_ret($4)|0);
  $$0 = $8;
 }
 STACKTOP = sp;return ($$0|0);
}
function _write($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $3 = 0, $4 = 0, $5 = 0, $vararg_buffer = 0, $vararg_ptr1 = 0, $vararg_ptr2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $3 = $1;
 HEAP32[$vararg_buffer>>2] = $0;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $3;
 $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
 HEAP32[$vararg_ptr2>>2] = $2;
 $4 = (___syscall4(4,($vararg_buffer|0))|0);
 $5 = (___syscall_ret($4)|0);
 STACKTOP = sp;return ($5|0);
}
function _read($0,$1,$2) {
 $0 = $0|0;
 $1 = $1|0;
 $2 = $2|0;
 var $3 = 0, $4 = 0, $5 = 0, $vararg_buffer = 0, $vararg_ptr1 = 0, $vararg_ptr2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $vararg_buffer = sp;
 $3 = $1;
 HEAP32[$vararg_buffer>>2] = $0;
 $vararg_ptr1 = ((($vararg_buffer)) + 4|0);
 HEAP32[$vararg_ptr1>>2] = $3;
 $vararg_ptr2 = ((($vararg_buffer)) + 8|0);
 HEAP32[$vararg_ptr2>>2] = $2;
 $4 = (___syscall3(3,($vararg_buffer|0))|0);
 $5 = (___syscall_ret($4)|0);
 STACKTOP = sp;return ($5|0);
}
function ___strerror_l($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$012$lcssa = 0, $$01214 = 0, $$016 = 0, $$113 = 0, $$115 = 0, $$115$ph = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
 var $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $$016 = 0;
 while(1) {
  $2 = (5216 + ($$016)|0);
  $3 = HEAP8[$2>>0]|0;
  $4 = $3&255;
  $5 = ($4|0)==($0|0);
  if ($5) {
   label = 4;
   break;
  }
  $6 = (($$016) + 1)|0;
  $7 = ($6|0)==(87);
  if ($7) {
   $$115$ph = 87;
   label = 5;
   break;
  } else {
   $$016 = $6;
  }
 }
 if ((label|0) == 4) {
  $8 = ($$016|0)==(0);
  if ($8) {
   $$012$lcssa = 5312;
  } else {
   $$115$ph = $$016;
   label = 5;
  }
 }
 if ((label|0) == 5) {
  $$01214 = 5312;$$115 = $$115$ph;
  while(1) {
   $$113 = $$01214;
   while(1) {
    $9 = HEAP8[$$113>>0]|0;
    $10 = ($9<<24>>24)==(0);
    $11 = ((($$113)) + 1|0);
    if ($10) {
     break;
    } else {
     $$113 = $11;
    }
   }
   $12 = (($$115) + -1)|0;
   $13 = ($12|0)==(0);
   if ($13) {
    $$012$lcssa = $11;
    break;
   } else {
    $$01214 = $11;$$115 = $12;
   }
  }
 }
 $14 = ((($1)) + 20|0);
 $15 = HEAP32[$14>>2]|0;
 $16 = (___lctrans($$012$lcssa,$15)|0);
 return ($16|0);
}
function ___lctrans($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $2 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = (___lctrans_impl($0,$1)|0);
 return ($2|0);
}
function _strerror($0) {
 $0 = $0|0;
 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = (___pthread_self_78()|0);
 $2 = ((($1)) + 188|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = (___strerror_l($0,$3)|0);
 return ($4|0);
}
function ___pthread_self_78() {
 var $0 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $0 = (_pthread_self()|0);
 return ($0|0);
}
function _fputc($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$0 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0;
 var $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ((($1)) + 76|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = ($3|0)<(0);
 if ($4) {
  label = 3;
 } else {
  $5 = (___lockfile($1)|0);
  $6 = ($5|0)==(0);
  if ($6) {
   label = 3;
  } else {
   $20 = $0&255;
   $21 = $0 & 255;
   $22 = ((($1)) + 75|0);
   $23 = HEAP8[$22>>0]|0;
   $24 = $23 << 24 >> 24;
   $25 = ($21|0)==($24|0);
   if ($25) {
    label = 10;
   } else {
    $26 = ((($1)) + 20|0);
    $27 = HEAP32[$26>>2]|0;
    $28 = ((($1)) + 16|0);
    $29 = HEAP32[$28>>2]|0;
    $30 = ($27>>>0)<($29>>>0);
    if ($30) {
     $31 = ((($27)) + 1|0);
     HEAP32[$26>>2] = $31;
     HEAP8[$27>>0] = $20;
     $33 = $21;
    } else {
     label = 10;
    }
   }
   if ((label|0) == 10) {
    $32 = (___overflow($1,$0)|0);
    $33 = $32;
   }
   ___unlockfile($1);
   $$0 = $33;
  }
 }
 do {
  if ((label|0) == 3) {
   $7 = $0&255;
   $8 = $0 & 255;
   $9 = ((($1)) + 75|0);
   $10 = HEAP8[$9>>0]|0;
   $11 = $10 << 24 >> 24;
   $12 = ($8|0)==($11|0);
   if (!($12)) {
    $13 = ((($1)) + 20|0);
    $14 = HEAP32[$13>>2]|0;
    $15 = ((($1)) + 16|0);
    $16 = HEAP32[$15>>2]|0;
    $17 = ($14>>>0)<($16>>>0);
    if ($17) {
     $18 = ((($14)) + 1|0);
     HEAP32[$13>>2] = $18;
     HEAP8[$14>>0] = $7;
     $$0 = $8;
     break;
    }
   }
   $19 = (___overflow($1,$0)|0);
   $$0 = $19;
  }
 } while(0);
 return ($$0|0);
}
function _perror($0) {
 $0 = $0|0;
 var $1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = HEAP32[1852]|0;
 $2 = (___errno_location()|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = (_strerror($3)|0);
 $5 = ((($1)) + 76|0);
 $6 = HEAP32[$5>>2]|0;
 $7 = ($6|0)>(-1);
 if ($7) {
  $8 = (___lockfile($1)|0);
  $15 = $8;
 } else {
  $15 = 0;
 }
 $9 = ($0|0)==(0|0);
 if (!($9)) {
  $10 = HEAP8[$0>>0]|0;
  $11 = ($10<<24>>24)==(0);
  if (!($11)) {
   $12 = (_strlen($0)|0);
   (_fwrite($0,$12,1,$1)|0);
   (_fputc(58,$1)|0);
   (_fputc(32,$1)|0);
  }
 }
 $13 = (_strlen($4)|0);
 (_fwrite($4,$13,1,$1)|0);
 (_fputc(10,$1)|0);
 $14 = ($15|0)==(0);
 if (!($14)) {
  ___unlockfile($1);
 }
 return;
}
function _malloc($0) {
 $0 = $0|0;
 var $$0 = 0, $$0$i = 0, $$0$i$i = 0, $$0$i$i$i = 0, $$0$i20$i = 0, $$0169$i = 0, $$0170$i = 0, $$0171$i = 0, $$0192 = 0, $$0194 = 0, $$02014$i$i = 0, $$0202$lcssa$i$i = 0, $$02023$i$i = 0, $$0206$i$i = 0, $$0207$i$i = 0, $$024372$i = 0, $$0259$i$i = 0, $$02604$i$i = 0, $$0261$lcssa$i$i = 0, $$02613$i$i = 0;
 var $$0267$i$i = 0, $$0268$i$i = 0, $$0318$i = 0, $$032012$i = 0, $$0321$lcssa$i = 0, $$032111$i = 0, $$0323$i = 0, $$0329$i = 0, $$0335$i = 0, $$0336$i = 0, $$0338$i = 0, $$0339$i = 0, $$0344$i = 0, $$1174$i = 0, $$1174$i$be = 0, $$1174$i$ph = 0, $$1176$i = 0, $$1176$i$be = 0, $$1176$i$ph = 0, $$124471$i = 0;
 var $$1263$i$i = 0, $$1263$i$i$be = 0, $$1263$i$i$ph = 0, $$1265$i$i = 0, $$1265$i$i$be = 0, $$1265$i$i$ph = 0, $$1319$i = 0, $$1324$i = 0, $$1340$i = 0, $$1346$i = 0, $$1346$i$be = 0, $$1346$i$ph = 0, $$1350$i = 0, $$1350$i$be = 0, $$1350$i$ph = 0, $$2234243136$i = 0, $$2247$ph$i = 0, $$2253$ph$i = 0, $$2331$i = 0, $$3$i = 0;
 var $$3$i$i = 0, $$3$i198 = 0, $$3$i198211 = 0, $$3326$i = 0, $$3348$i = 0, $$4$lcssa$i = 0, $$415$i = 0, $$415$i$ph = 0, $$4236$i = 0, $$4327$lcssa$i = 0, $$432714$i = 0, $$432714$i$ph = 0, $$4333$i = 0, $$533413$i = 0, $$533413$i$ph = 0, $$723947$i = 0, $$748$i = 0, $$pre = 0, $$pre$i = 0, $$pre$i$i = 0;
 var $$pre$i16$i = 0, $$pre$i195 = 0, $$pre$i204 = 0, $$pre$phi$i$iZ2D = 0, $$pre$phi$i17$iZ2D = 0, $$pre$phi$i205Z2D = 0, $$pre$phi$iZ2D = 0, $$pre$phiZ2D = 0, $$sink = 0, $$sink320 = 0, $$sink321 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0;
 var $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0;
 var $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0;
 var $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0;
 var $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0;
 var $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0, $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0;
 var $198 = 0, $199 = 0, $2 = 0, $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0, $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0;
 var $215 = 0, $216 = 0, $217 = 0, $218 = 0, $219 = 0, $22 = 0, $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0, $226 = 0, $227 = 0, $228 = 0, $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0;
 var $233 = 0, $234 = 0, $235 = 0, $236 = 0, $237 = 0, $238 = 0, $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0, $244 = 0, $245 = 0, $246 = 0, $247 = 0, $248 = 0, $249 = 0, $25 = 0, $250 = 0;
 var $251 = 0, $252 = 0, $253 = 0, $254 = 0, $255 = 0, $256 = 0, $257 = 0, $258 = 0, $259 = 0, $26 = 0, $260 = 0, $261 = 0, $262 = 0, $263 = 0, $264 = 0, $265 = 0, $266 = 0, $267 = 0, $268 = 0, $269 = 0;
 var $27 = 0, $270 = 0, $271 = 0, $272 = 0, $273 = 0, $274 = 0, $275 = 0, $276 = 0, $277 = 0, $278 = 0, $279 = 0, $28 = 0, $280 = 0, $281 = 0, $282 = 0, $283 = 0, $284 = 0, $285 = 0, $286 = 0, $287 = 0;
 var $288 = 0, $289 = 0, $29 = 0, $290 = 0, $291 = 0, $292 = 0, $293 = 0, $294 = 0, $295 = 0, $296 = 0, $297 = 0, $298 = 0, $299 = 0, $3 = 0, $30 = 0, $300 = 0, $301 = 0, $302 = 0, $303 = 0, $304 = 0;
 var $305 = 0, $306 = 0, $307 = 0, $308 = 0, $309 = 0, $31 = 0, $310 = 0, $311 = 0, $312 = 0, $313 = 0, $314 = 0, $315 = 0, $316 = 0, $317 = 0, $318 = 0, $319 = 0, $32 = 0, $320 = 0, $321 = 0, $322 = 0;
 var $323 = 0, $324 = 0, $325 = 0, $326 = 0, $327 = 0, $328 = 0, $329 = 0, $33 = 0, $330 = 0, $331 = 0, $332 = 0, $333 = 0, $334 = 0, $335 = 0, $336 = 0, $337 = 0, $338 = 0, $339 = 0, $34 = 0, $340 = 0;
 var $341 = 0, $342 = 0, $343 = 0, $344 = 0, $345 = 0, $346 = 0, $347 = 0, $348 = 0, $349 = 0, $35 = 0, $350 = 0, $351 = 0, $352 = 0, $353 = 0, $354 = 0, $355 = 0, $356 = 0, $357 = 0, $358 = 0, $359 = 0;
 var $36 = 0, $360 = 0, $361 = 0, $362 = 0, $363 = 0, $364 = 0, $365 = 0, $366 = 0, $367 = 0, $368 = 0, $369 = 0, $37 = 0, $370 = 0, $371 = 0, $372 = 0, $373 = 0, $374 = 0, $375 = 0, $376 = 0, $377 = 0;
 var $378 = 0, $379 = 0, $38 = 0, $380 = 0, $381 = 0, $382 = 0, $383 = 0, $384 = 0, $385 = 0, $386 = 0, $387 = 0, $388 = 0, $389 = 0, $39 = 0, $390 = 0, $391 = 0, $392 = 0, $393 = 0, $394 = 0, $395 = 0;
 var $396 = 0, $397 = 0, $398 = 0, $399 = 0, $4 = 0, $40 = 0, $400 = 0, $401 = 0, $402 = 0, $403 = 0, $404 = 0, $405 = 0, $406 = 0, $407 = 0, $408 = 0, $409 = 0, $41 = 0, $410 = 0, $411 = 0, $412 = 0;
 var $413 = 0, $414 = 0, $415 = 0, $416 = 0, $417 = 0, $418 = 0, $419 = 0, $42 = 0, $420 = 0, $421 = 0, $422 = 0, $423 = 0, $424 = 0, $425 = 0, $426 = 0, $427 = 0, $428 = 0, $429 = 0, $43 = 0, $430 = 0;
 var $431 = 0, $432 = 0, $433 = 0, $434 = 0, $435 = 0, $436 = 0, $437 = 0, $438 = 0, $439 = 0, $44 = 0, $440 = 0, $441 = 0, $442 = 0, $443 = 0, $444 = 0, $445 = 0, $446 = 0, $447 = 0, $448 = 0, $449 = 0;
 var $45 = 0, $450 = 0, $451 = 0, $452 = 0, $453 = 0, $454 = 0, $455 = 0, $456 = 0, $457 = 0, $458 = 0, $459 = 0, $46 = 0, $460 = 0, $461 = 0, $462 = 0, $463 = 0, $464 = 0, $465 = 0, $466 = 0, $467 = 0;
 var $468 = 0, $469 = 0, $47 = 0, $470 = 0, $471 = 0, $472 = 0, $473 = 0, $474 = 0, $475 = 0, $476 = 0, $477 = 0, $478 = 0, $479 = 0, $48 = 0, $480 = 0, $481 = 0, $482 = 0, $483 = 0, $484 = 0, $485 = 0;
 var $486 = 0, $487 = 0, $488 = 0, $489 = 0, $49 = 0, $490 = 0, $491 = 0, $492 = 0, $493 = 0, $494 = 0, $495 = 0, $496 = 0, $497 = 0, $498 = 0, $499 = 0, $5 = 0, $50 = 0, $500 = 0, $501 = 0, $502 = 0;
 var $503 = 0, $504 = 0, $505 = 0, $506 = 0, $507 = 0, $508 = 0, $509 = 0, $51 = 0, $510 = 0, $511 = 0, $512 = 0, $513 = 0, $514 = 0, $515 = 0, $516 = 0, $517 = 0, $518 = 0, $519 = 0, $52 = 0, $520 = 0;
 var $521 = 0, $522 = 0, $523 = 0, $524 = 0, $525 = 0, $526 = 0, $527 = 0, $528 = 0, $529 = 0, $53 = 0, $530 = 0, $531 = 0, $532 = 0, $533 = 0, $534 = 0, $535 = 0, $536 = 0, $537 = 0, $538 = 0, $539 = 0;
 var $54 = 0, $540 = 0, $541 = 0, $542 = 0, $543 = 0, $544 = 0, $545 = 0, $546 = 0, $547 = 0, $548 = 0, $549 = 0, $55 = 0, $550 = 0, $551 = 0, $552 = 0, $553 = 0, $554 = 0, $555 = 0, $556 = 0, $557 = 0;
 var $558 = 0, $559 = 0, $56 = 0, $560 = 0, $561 = 0, $562 = 0, $563 = 0, $564 = 0, $565 = 0, $566 = 0, $567 = 0, $568 = 0, $569 = 0, $57 = 0, $570 = 0, $571 = 0, $572 = 0, $573 = 0, $574 = 0, $575 = 0;
 var $576 = 0, $577 = 0, $578 = 0, $579 = 0, $58 = 0, $580 = 0, $581 = 0, $582 = 0, $583 = 0, $584 = 0, $585 = 0, $586 = 0, $587 = 0, $588 = 0, $589 = 0, $59 = 0, $590 = 0, $591 = 0, $592 = 0, $593 = 0;
 var $594 = 0, $595 = 0, $596 = 0, $597 = 0, $598 = 0, $599 = 0, $6 = 0, $60 = 0, $600 = 0, $601 = 0, $602 = 0, $603 = 0, $604 = 0, $605 = 0, $606 = 0, $607 = 0, $608 = 0, $609 = 0, $61 = 0, $610 = 0;
 var $611 = 0, $612 = 0, $613 = 0, $614 = 0, $615 = 0, $616 = 0, $617 = 0, $618 = 0, $619 = 0, $62 = 0, $620 = 0, $621 = 0, $622 = 0, $623 = 0, $624 = 0, $625 = 0, $626 = 0, $627 = 0, $628 = 0, $629 = 0;
 var $63 = 0, $630 = 0, $631 = 0, $632 = 0, $633 = 0, $634 = 0, $635 = 0, $636 = 0, $637 = 0, $638 = 0, $639 = 0, $64 = 0, $640 = 0, $641 = 0, $642 = 0, $643 = 0, $644 = 0, $645 = 0, $646 = 0, $647 = 0;
 var $648 = 0, $649 = 0, $65 = 0, $650 = 0, $651 = 0, $652 = 0, $653 = 0, $654 = 0, $655 = 0, $656 = 0, $657 = 0, $658 = 0, $659 = 0, $66 = 0, $660 = 0, $661 = 0, $662 = 0, $663 = 0, $664 = 0, $665 = 0;
 var $666 = 0, $667 = 0, $668 = 0, $669 = 0, $67 = 0, $670 = 0, $671 = 0, $672 = 0, $673 = 0, $674 = 0, $675 = 0, $676 = 0, $677 = 0, $678 = 0, $679 = 0, $68 = 0, $680 = 0, $681 = 0, $682 = 0, $683 = 0;
 var $684 = 0, $685 = 0, $686 = 0, $687 = 0, $688 = 0, $689 = 0, $69 = 0, $690 = 0, $691 = 0, $692 = 0, $693 = 0, $694 = 0, $695 = 0, $696 = 0, $697 = 0, $698 = 0, $699 = 0, $7 = 0, $70 = 0, $700 = 0;
 var $701 = 0, $702 = 0, $703 = 0, $704 = 0, $705 = 0, $706 = 0, $707 = 0, $708 = 0, $709 = 0, $71 = 0, $710 = 0, $711 = 0, $712 = 0, $713 = 0, $714 = 0, $715 = 0, $716 = 0, $717 = 0, $718 = 0, $719 = 0;
 var $72 = 0, $720 = 0, $721 = 0, $722 = 0, $723 = 0, $724 = 0, $725 = 0, $726 = 0, $727 = 0, $728 = 0, $729 = 0, $73 = 0, $730 = 0, $731 = 0, $732 = 0, $733 = 0, $734 = 0, $735 = 0, $736 = 0, $737 = 0;
 var $738 = 0, $739 = 0, $74 = 0, $740 = 0, $741 = 0, $742 = 0, $743 = 0, $744 = 0, $745 = 0, $746 = 0, $747 = 0, $748 = 0, $749 = 0, $75 = 0, $750 = 0, $751 = 0, $752 = 0, $753 = 0, $754 = 0, $755 = 0;
 var $756 = 0, $757 = 0, $758 = 0, $759 = 0, $76 = 0, $760 = 0, $761 = 0, $762 = 0, $763 = 0, $764 = 0, $765 = 0, $766 = 0, $767 = 0, $768 = 0, $769 = 0, $77 = 0, $770 = 0, $771 = 0, $772 = 0, $773 = 0;
 var $774 = 0, $775 = 0, $776 = 0, $777 = 0, $778 = 0, $779 = 0, $78 = 0, $780 = 0, $781 = 0, $782 = 0, $783 = 0, $784 = 0, $785 = 0, $786 = 0, $787 = 0, $788 = 0, $789 = 0, $79 = 0, $790 = 0, $791 = 0;
 var $792 = 0, $793 = 0, $794 = 0, $795 = 0, $796 = 0, $797 = 0, $798 = 0, $799 = 0, $8 = 0, $80 = 0, $800 = 0, $801 = 0, $802 = 0, $803 = 0, $804 = 0, $805 = 0, $806 = 0, $807 = 0, $808 = 0, $809 = 0;
 var $81 = 0, $810 = 0, $811 = 0, $812 = 0, $813 = 0, $814 = 0, $815 = 0, $816 = 0, $817 = 0, $818 = 0, $819 = 0, $82 = 0, $820 = 0, $821 = 0, $822 = 0, $823 = 0, $824 = 0, $825 = 0, $826 = 0, $827 = 0;
 var $828 = 0, $829 = 0, $83 = 0, $830 = 0, $831 = 0, $832 = 0, $833 = 0, $834 = 0, $835 = 0, $836 = 0, $837 = 0, $838 = 0, $839 = 0, $84 = 0, $840 = 0, $841 = 0, $842 = 0, $843 = 0, $844 = 0, $845 = 0;
 var $846 = 0, $847 = 0, $848 = 0, $849 = 0, $85 = 0, $850 = 0, $851 = 0, $852 = 0, $853 = 0, $854 = 0, $855 = 0, $856 = 0, $857 = 0, $858 = 0, $859 = 0, $86 = 0, $860 = 0, $861 = 0, $862 = 0, $863 = 0;
 var $864 = 0, $865 = 0, $866 = 0, $867 = 0, $868 = 0, $869 = 0, $87 = 0, $870 = 0, $871 = 0, $872 = 0, $873 = 0, $874 = 0, $875 = 0, $876 = 0, $877 = 0, $878 = 0, $879 = 0, $88 = 0, $880 = 0, $881 = 0;
 var $882 = 0, $883 = 0, $884 = 0, $885 = 0, $886 = 0, $887 = 0, $888 = 0, $889 = 0, $89 = 0, $890 = 0, $891 = 0, $892 = 0, $893 = 0, $894 = 0, $895 = 0, $896 = 0, $897 = 0, $898 = 0, $899 = 0, $9 = 0;
 var $90 = 0, $900 = 0, $901 = 0, $902 = 0, $903 = 0, $904 = 0, $905 = 0, $906 = 0, $907 = 0, $908 = 0, $909 = 0, $91 = 0, $910 = 0, $911 = 0, $912 = 0, $913 = 0, $914 = 0, $915 = 0, $916 = 0, $917 = 0;
 var $918 = 0, $919 = 0, $92 = 0, $920 = 0, $921 = 0, $922 = 0, $923 = 0, $924 = 0, $925 = 0, $926 = 0, $927 = 0, $928 = 0, $929 = 0, $93 = 0, $930 = 0, $931 = 0, $932 = 0, $933 = 0, $934 = 0, $935 = 0;
 var $936 = 0, $937 = 0, $938 = 0, $939 = 0, $94 = 0, $940 = 0, $941 = 0, $942 = 0, $943 = 0, $944 = 0, $945 = 0, $946 = 0, $947 = 0, $948 = 0, $949 = 0, $95 = 0, $950 = 0, $951 = 0, $952 = 0, $953 = 0;
 var $954 = 0, $955 = 0, $956 = 0, $957 = 0, $958 = 0, $959 = 0, $96 = 0, $960 = 0, $961 = 0, $962 = 0, $963 = 0, $964 = 0, $965 = 0, $966 = 0, $967 = 0, $968 = 0, $969 = 0, $97 = 0, $970 = 0, $971 = 0;
 var $972 = 0, $973 = 0, $974 = 0, $975 = 0, $976 = 0, $977 = 0, $978 = 0, $979 = 0, $98 = 0, $99 = 0, $cond$i = 0, $cond$i$i = 0, $cond$i203 = 0, $not$$i = 0, $or$cond$i = 0, $or$cond$i199 = 0, $or$cond1$i = 0, $or$cond1$i197 = 0, $or$cond11$i = 0, $or$cond2$i = 0;
 var $or$cond5$i = 0, $or$cond50$i = 0, $or$cond51$i = 0, $or$cond6$i = 0, $or$cond7$i = 0, $or$cond8$i = 0, $or$cond8$not$i = 0, $spec$select$i = 0, $spec$select$i201 = 0, $spec$select1$i = 0, $spec$select2$i = 0, $spec$select4$i = 0, $spec$select49$i = 0, $spec$select9$i = 0, label = 0, sp = 0;
 sp = STACKTOP;
 STACKTOP = STACKTOP + 16|0; if ((STACKTOP|0) >= (STACK_MAX|0)) abortStackOverflow(16|0);
 $1 = sp;
 $2 = ($0>>>0)<(245);
 do {
  if ($2) {
   $3 = ($0>>>0)<(11);
   $4 = (($0) + 11)|0;
   $5 = $4 & -8;
   $6 = $3 ? 16 : $5;
   $7 = $6 >>> 3;
   $8 = HEAP32[2332]|0;
   $9 = $8 >>> $7;
   $10 = $9 & 3;
   $11 = ($10|0)==(0);
   if (!($11)) {
    $12 = $9 & 1;
    $13 = $12 ^ 1;
    $14 = (($13) + ($7))|0;
    $15 = $14 << 1;
    $16 = (9368 + ($15<<2)|0);
    $17 = ((($16)) + 8|0);
    $18 = HEAP32[$17>>2]|0;
    $19 = ((($18)) + 8|0);
    $20 = HEAP32[$19>>2]|0;
    $21 = ($20|0)==($16|0);
    if ($21) {
     $22 = 1 << $14;
     $23 = $22 ^ -1;
     $24 = $8 & $23;
     HEAP32[2332] = $24;
    } else {
     $25 = ((($20)) + 12|0);
     HEAP32[$25>>2] = $16;
     HEAP32[$17>>2] = $20;
    }
    $26 = $14 << 3;
    $27 = $26 | 3;
    $28 = ((($18)) + 4|0);
    HEAP32[$28>>2] = $27;
    $29 = (($18) + ($26)|0);
    $30 = ((($29)) + 4|0);
    $31 = HEAP32[$30>>2]|0;
    $32 = $31 | 1;
    HEAP32[$30>>2] = $32;
    $$0 = $19;
    STACKTOP = sp;return ($$0|0);
   }
   $33 = HEAP32[(9336)>>2]|0;
   $34 = ($6>>>0)>($33>>>0);
   if ($34) {
    $35 = ($9|0)==(0);
    if (!($35)) {
     $36 = $9 << $7;
     $37 = 2 << $7;
     $38 = (0 - ($37))|0;
     $39 = $37 | $38;
     $40 = $36 & $39;
     $41 = (0 - ($40))|0;
     $42 = $40 & $41;
     $43 = (($42) + -1)|0;
     $44 = $43 >>> 12;
     $45 = $44 & 16;
     $46 = $43 >>> $45;
     $47 = $46 >>> 5;
     $48 = $47 & 8;
     $49 = $48 | $45;
     $50 = $46 >>> $48;
     $51 = $50 >>> 2;
     $52 = $51 & 4;
     $53 = $49 | $52;
     $54 = $50 >>> $52;
     $55 = $54 >>> 1;
     $56 = $55 & 2;
     $57 = $53 | $56;
     $58 = $54 >>> $56;
     $59 = $58 >>> 1;
     $60 = $59 & 1;
     $61 = $57 | $60;
     $62 = $58 >>> $60;
     $63 = (($61) + ($62))|0;
     $64 = $63 << 1;
     $65 = (9368 + ($64<<2)|0);
     $66 = ((($65)) + 8|0);
     $67 = HEAP32[$66>>2]|0;
     $68 = ((($67)) + 8|0);
     $69 = HEAP32[$68>>2]|0;
     $70 = ($69|0)==($65|0);
     if ($70) {
      $71 = 1 << $63;
      $72 = $71 ^ -1;
      $73 = $8 & $72;
      HEAP32[2332] = $73;
      $90 = $73;
     } else {
      $74 = ((($69)) + 12|0);
      HEAP32[$74>>2] = $65;
      HEAP32[$66>>2] = $69;
      $90 = $8;
     }
     $75 = $63 << 3;
     $76 = (($75) - ($6))|0;
     $77 = $6 | 3;
     $78 = ((($67)) + 4|0);
     HEAP32[$78>>2] = $77;
     $79 = (($67) + ($6)|0);
     $80 = $76 | 1;
     $81 = ((($79)) + 4|0);
     HEAP32[$81>>2] = $80;
     $82 = (($67) + ($75)|0);
     HEAP32[$82>>2] = $76;
     $83 = ($33|0)==(0);
     if (!($83)) {
      $84 = HEAP32[(9348)>>2]|0;
      $85 = $33 >>> 3;
      $86 = $85 << 1;
      $87 = (9368 + ($86<<2)|0);
      $88 = 1 << $85;
      $89 = $90 & $88;
      $91 = ($89|0)==(0);
      if ($91) {
       $92 = $90 | $88;
       HEAP32[2332] = $92;
       $$pre = ((($87)) + 8|0);
       $$0194 = $87;$$pre$phiZ2D = $$pre;
      } else {
       $93 = ((($87)) + 8|0);
       $94 = HEAP32[$93>>2]|0;
       $$0194 = $94;$$pre$phiZ2D = $93;
      }
      HEAP32[$$pre$phiZ2D>>2] = $84;
      $95 = ((($$0194)) + 12|0);
      HEAP32[$95>>2] = $84;
      $96 = ((($84)) + 8|0);
      HEAP32[$96>>2] = $$0194;
      $97 = ((($84)) + 12|0);
      HEAP32[$97>>2] = $87;
     }
     HEAP32[(9336)>>2] = $76;
     HEAP32[(9348)>>2] = $79;
     $$0 = $68;
     STACKTOP = sp;return ($$0|0);
    }
    $98 = HEAP32[(9332)>>2]|0;
    $99 = ($98|0)==(0);
    if ($99) {
     $$0192 = $6;
    } else {
     $100 = (0 - ($98))|0;
     $101 = $98 & $100;
     $102 = (($101) + -1)|0;
     $103 = $102 >>> 12;
     $104 = $103 & 16;
     $105 = $102 >>> $104;
     $106 = $105 >>> 5;
     $107 = $106 & 8;
     $108 = $107 | $104;
     $109 = $105 >>> $107;
     $110 = $109 >>> 2;
     $111 = $110 & 4;
     $112 = $108 | $111;
     $113 = $109 >>> $111;
     $114 = $113 >>> 1;
     $115 = $114 & 2;
     $116 = $112 | $115;
     $117 = $113 >>> $115;
     $118 = $117 >>> 1;
     $119 = $118 & 1;
     $120 = $116 | $119;
     $121 = $117 >>> $119;
     $122 = (($120) + ($121))|0;
     $123 = (9632 + ($122<<2)|0);
     $124 = HEAP32[$123>>2]|0;
     $125 = ((($124)) + 4|0);
     $126 = HEAP32[$125>>2]|0;
     $127 = $126 & -8;
     $128 = (($127) - ($6))|0;
     $$0169$i = $124;$$0170$i = $124;$$0171$i = $128;
     while(1) {
      $129 = ((($$0169$i)) + 16|0);
      $130 = HEAP32[$129>>2]|0;
      $131 = ($130|0)==(0|0);
      if ($131) {
       $132 = ((($$0169$i)) + 20|0);
       $133 = HEAP32[$132>>2]|0;
       $134 = ($133|0)==(0|0);
       if ($134) {
        break;
       } else {
        $136 = $133;
       }
      } else {
       $136 = $130;
      }
      $135 = ((($136)) + 4|0);
      $137 = HEAP32[$135>>2]|0;
      $138 = $137 & -8;
      $139 = (($138) - ($6))|0;
      $140 = ($139>>>0)<($$0171$i>>>0);
      $spec$select$i = $140 ? $139 : $$0171$i;
      $spec$select1$i = $140 ? $136 : $$0170$i;
      $$0169$i = $136;$$0170$i = $spec$select1$i;$$0171$i = $spec$select$i;
     }
     $141 = (($$0170$i) + ($6)|0);
     $142 = ($141>>>0)>($$0170$i>>>0);
     if ($142) {
      $143 = ((($$0170$i)) + 24|0);
      $144 = HEAP32[$143>>2]|0;
      $145 = ((($$0170$i)) + 12|0);
      $146 = HEAP32[$145>>2]|0;
      $147 = ($146|0)==($$0170$i|0);
      do {
       if ($147) {
        $152 = ((($$0170$i)) + 20|0);
        $153 = HEAP32[$152>>2]|0;
        $154 = ($153|0)==(0|0);
        if ($154) {
         $155 = ((($$0170$i)) + 16|0);
         $156 = HEAP32[$155>>2]|0;
         $157 = ($156|0)==(0|0);
         if ($157) {
          $$3$i = 0;
          break;
         } else {
          $$1174$i$ph = $156;$$1176$i$ph = $155;
         }
        } else {
         $$1174$i$ph = $153;$$1176$i$ph = $152;
        }
        $$1174$i = $$1174$i$ph;$$1176$i = $$1176$i$ph;
        while(1) {
         $158 = ((($$1174$i)) + 20|0);
         $159 = HEAP32[$158>>2]|0;
         $160 = ($159|0)==(0|0);
         if ($160) {
          $161 = ((($$1174$i)) + 16|0);
          $162 = HEAP32[$161>>2]|0;
          $163 = ($162|0)==(0|0);
          if ($163) {
           break;
          } else {
           $$1174$i$be = $162;$$1176$i$be = $161;
          }
         } else {
          $$1174$i$be = $159;$$1176$i$be = $158;
         }
         $$1174$i = $$1174$i$be;$$1176$i = $$1176$i$be;
        }
        HEAP32[$$1176$i>>2] = 0;
        $$3$i = $$1174$i;
       } else {
        $148 = ((($$0170$i)) + 8|0);
        $149 = HEAP32[$148>>2]|0;
        $150 = ((($149)) + 12|0);
        HEAP32[$150>>2] = $146;
        $151 = ((($146)) + 8|0);
        HEAP32[$151>>2] = $149;
        $$3$i = $146;
       }
      } while(0);
      $164 = ($144|0)==(0|0);
      do {
       if (!($164)) {
        $165 = ((($$0170$i)) + 28|0);
        $166 = HEAP32[$165>>2]|0;
        $167 = (9632 + ($166<<2)|0);
        $168 = HEAP32[$167>>2]|0;
        $169 = ($$0170$i|0)==($168|0);
        if ($169) {
         HEAP32[$167>>2] = $$3$i;
         $cond$i = ($$3$i|0)==(0|0);
         if ($cond$i) {
          $170 = 1 << $166;
          $171 = $170 ^ -1;
          $172 = $98 & $171;
          HEAP32[(9332)>>2] = $172;
          break;
         }
        } else {
         $173 = ((($144)) + 16|0);
         $174 = HEAP32[$173>>2]|0;
         $175 = ($174|0)==($$0170$i|0);
         $176 = ((($144)) + 20|0);
         $$sink = $175 ? $173 : $176;
         HEAP32[$$sink>>2] = $$3$i;
         $177 = ($$3$i|0)==(0|0);
         if ($177) {
          break;
         }
        }
        $178 = ((($$3$i)) + 24|0);
        HEAP32[$178>>2] = $144;
        $179 = ((($$0170$i)) + 16|0);
        $180 = HEAP32[$179>>2]|0;
        $181 = ($180|0)==(0|0);
        if (!($181)) {
         $182 = ((($$3$i)) + 16|0);
         HEAP32[$182>>2] = $180;
         $183 = ((($180)) + 24|0);
         HEAP32[$183>>2] = $$3$i;
        }
        $184 = ((($$0170$i)) + 20|0);
        $185 = HEAP32[$184>>2]|0;
        $186 = ($185|0)==(0|0);
        if (!($186)) {
         $187 = ((($$3$i)) + 20|0);
         HEAP32[$187>>2] = $185;
         $188 = ((($185)) + 24|0);
         HEAP32[$188>>2] = $$3$i;
        }
       }
      } while(0);
      $189 = ($$0171$i>>>0)<(16);
      if ($189) {
       $190 = (($$0171$i) + ($6))|0;
       $191 = $190 | 3;
       $192 = ((($$0170$i)) + 4|0);
       HEAP32[$192>>2] = $191;
       $193 = (($$0170$i) + ($190)|0);
       $194 = ((($193)) + 4|0);
       $195 = HEAP32[$194>>2]|0;
       $196 = $195 | 1;
       HEAP32[$194>>2] = $196;
      } else {
       $197 = $6 | 3;
       $198 = ((($$0170$i)) + 4|0);
       HEAP32[$198>>2] = $197;
       $199 = $$0171$i | 1;
       $200 = ((($141)) + 4|0);
       HEAP32[$200>>2] = $199;
       $201 = (($141) + ($$0171$i)|0);
       HEAP32[$201>>2] = $$0171$i;
       $202 = ($33|0)==(0);
       if (!($202)) {
        $203 = HEAP32[(9348)>>2]|0;
        $204 = $33 >>> 3;
        $205 = $204 << 1;
        $206 = (9368 + ($205<<2)|0);
        $207 = 1 << $204;
        $208 = $207 & $8;
        $209 = ($208|0)==(0);
        if ($209) {
         $210 = $207 | $8;
         HEAP32[2332] = $210;
         $$pre$i = ((($206)) + 8|0);
         $$0$i = $206;$$pre$phi$iZ2D = $$pre$i;
        } else {
         $211 = ((($206)) + 8|0);
         $212 = HEAP32[$211>>2]|0;
         $$0$i = $212;$$pre$phi$iZ2D = $211;
        }
        HEAP32[$$pre$phi$iZ2D>>2] = $203;
        $213 = ((($$0$i)) + 12|0);
        HEAP32[$213>>2] = $203;
        $214 = ((($203)) + 8|0);
        HEAP32[$214>>2] = $$0$i;
        $215 = ((($203)) + 12|0);
        HEAP32[$215>>2] = $206;
       }
       HEAP32[(9336)>>2] = $$0171$i;
       HEAP32[(9348)>>2] = $141;
      }
      $216 = ((($$0170$i)) + 8|0);
      $$0 = $216;
      STACKTOP = sp;return ($$0|0);
     } else {
      $$0192 = $6;
     }
    }
   } else {
    $$0192 = $6;
   }
  } else {
   $217 = ($0>>>0)>(4294967231);
   if ($217) {
    $$0192 = -1;
   } else {
    $218 = (($0) + 11)|0;
    $219 = $218 & -8;
    $220 = HEAP32[(9332)>>2]|0;
    $221 = ($220|0)==(0);
    if ($221) {
     $$0192 = $219;
    } else {
     $222 = (0 - ($219))|0;
     $223 = $218 >>> 8;
     $224 = ($223|0)==(0);
     if ($224) {
      $$0335$i = 0;
     } else {
      $225 = ($219>>>0)>(16777215);
      if ($225) {
       $$0335$i = 31;
      } else {
       $226 = (($223) + 1048320)|0;
       $227 = $226 >>> 16;
       $228 = $227 & 8;
       $229 = $223 << $228;
       $230 = (($229) + 520192)|0;
       $231 = $230 >>> 16;
       $232 = $231 & 4;
       $233 = $232 | $228;
       $234 = $229 << $232;
       $235 = (($234) + 245760)|0;
       $236 = $235 >>> 16;
       $237 = $236 & 2;
       $238 = $233 | $237;
       $239 = (14 - ($238))|0;
       $240 = $234 << $237;
       $241 = $240 >>> 15;
       $242 = (($239) + ($241))|0;
       $243 = $242 << 1;
       $244 = (($242) + 7)|0;
       $245 = $219 >>> $244;
       $246 = $245 & 1;
       $247 = $246 | $243;
       $$0335$i = $247;
      }
     }
     $248 = (9632 + ($$0335$i<<2)|0);
     $249 = HEAP32[$248>>2]|0;
     $250 = ($249|0)==(0|0);
     L79: do {
      if ($250) {
       $$2331$i = 0;$$3$i198 = 0;$$3326$i = $222;
       label = 61;
      } else {
       $251 = ($$0335$i|0)==(31);
       $252 = $$0335$i >>> 1;
       $253 = (25 - ($252))|0;
       $254 = $251 ? 0 : $253;
       $255 = $219 << $254;
       $$0318$i = 0;$$0323$i = $222;$$0329$i = $249;$$0336$i = $255;$$0339$i = 0;
       while(1) {
        $256 = ((($$0329$i)) + 4|0);
        $257 = HEAP32[$256>>2]|0;
        $258 = $257 & -8;
        $259 = (($258) - ($219))|0;
        $260 = ($259>>>0)<($$0323$i>>>0);
        if ($260) {
         $261 = ($259|0)==(0);
         if ($261) {
          $$415$i$ph = $$0329$i;$$432714$i$ph = 0;$$533413$i$ph = $$0329$i;
          label = 65;
          break L79;
         } else {
          $$1319$i = $$0329$i;$$1324$i = $259;
         }
        } else {
         $$1319$i = $$0318$i;$$1324$i = $$0323$i;
        }
        $262 = ((($$0329$i)) + 20|0);
        $263 = HEAP32[$262>>2]|0;
        $264 = $$0336$i >>> 31;
        $265 = (((($$0329$i)) + 16|0) + ($264<<2)|0);
        $266 = HEAP32[$265>>2]|0;
        $267 = ($263|0)==(0|0);
        $268 = ($263|0)==($266|0);
        $or$cond1$i197 = $267 | $268;
        $$1340$i = $or$cond1$i197 ? $$0339$i : $263;
        $269 = ($266|0)==(0|0);
        $spec$select4$i = $$0336$i << 1;
        if ($269) {
         $$2331$i = $$1340$i;$$3$i198 = $$1319$i;$$3326$i = $$1324$i;
         label = 61;
         break;
        } else {
         $$0318$i = $$1319$i;$$0323$i = $$1324$i;$$0329$i = $266;$$0336$i = $spec$select4$i;$$0339$i = $$1340$i;
        }
       }
      }
     } while(0);
     if ((label|0) == 61) {
      $270 = ($$2331$i|0)==(0|0);
      $271 = ($$3$i198|0)==(0|0);
      $or$cond$i199 = $270 & $271;
      if ($or$cond$i199) {
       $272 = 2 << $$0335$i;
       $273 = (0 - ($272))|0;
       $274 = $272 | $273;
       $275 = $274 & $220;
       $276 = ($275|0)==(0);
       if ($276) {
        $$0192 = $219;
        break;
       }
       $277 = (0 - ($275))|0;
       $278 = $275 & $277;
       $279 = (($278) + -1)|0;
       $280 = $279 >>> 12;
       $281 = $280 & 16;
       $282 = $279 >>> $281;
       $283 = $282 >>> 5;
       $284 = $283 & 8;
       $285 = $284 | $281;
       $286 = $282 >>> $284;
       $287 = $286 >>> 2;
       $288 = $287 & 4;
       $289 = $285 | $288;
       $290 = $286 >>> $288;
       $291 = $290 >>> 1;
       $292 = $291 & 2;
       $293 = $289 | $292;
       $294 = $290 >>> $292;
       $295 = $294 >>> 1;
       $296 = $295 & 1;
       $297 = $293 | $296;
       $298 = $294 >>> $296;
       $299 = (($297) + ($298))|0;
       $300 = (9632 + ($299<<2)|0);
       $301 = HEAP32[$300>>2]|0;
       $$3$i198211 = 0;$$4333$i = $301;
      } else {
       $$3$i198211 = $$3$i198;$$4333$i = $$2331$i;
      }
      $302 = ($$4333$i|0)==(0|0);
      if ($302) {
       $$4$lcssa$i = $$3$i198211;$$4327$lcssa$i = $$3326$i;
      } else {
       $$415$i$ph = $$3$i198211;$$432714$i$ph = $$3326$i;$$533413$i$ph = $$4333$i;
       label = 65;
      }
     }
     if ((label|0) == 65) {
      $$415$i = $$415$i$ph;$$432714$i = $$432714$i$ph;$$533413$i = $$533413$i$ph;
      while(1) {
       $303 = ((($$533413$i)) + 4|0);
       $304 = HEAP32[$303>>2]|0;
       $305 = $304 & -8;
       $306 = (($305) - ($219))|0;
       $307 = ($306>>>0)<($$432714$i>>>0);
       $spec$select$i201 = $307 ? $306 : $$432714$i;
       $spec$select2$i = $307 ? $$533413$i : $$415$i;
       $308 = ((($$533413$i)) + 16|0);
       $309 = HEAP32[$308>>2]|0;
       $310 = ($309|0)==(0|0);
       if ($310) {
        $311 = ((($$533413$i)) + 20|0);
        $312 = HEAP32[$311>>2]|0;
        $314 = $312;
       } else {
        $314 = $309;
       }
       $313 = ($314|0)==(0|0);
       if ($313) {
        $$4$lcssa$i = $spec$select2$i;$$4327$lcssa$i = $spec$select$i201;
        break;
       } else {
        $$415$i = $spec$select2$i;$$432714$i = $spec$select$i201;$$533413$i = $314;
       }
      }
     }
     $315 = ($$4$lcssa$i|0)==(0|0);
     if ($315) {
      $$0192 = $219;
     } else {
      $316 = HEAP32[(9336)>>2]|0;
      $317 = (($316) - ($219))|0;
      $318 = ($$4327$lcssa$i>>>0)<($317>>>0);
      if ($318) {
       $319 = (($$4$lcssa$i) + ($219)|0);
       $320 = ($319>>>0)>($$4$lcssa$i>>>0);
       if ($320) {
        $321 = ((($$4$lcssa$i)) + 24|0);
        $322 = HEAP32[$321>>2]|0;
        $323 = ((($$4$lcssa$i)) + 12|0);
        $324 = HEAP32[$323>>2]|0;
        $325 = ($324|0)==($$4$lcssa$i|0);
        do {
         if ($325) {
          $330 = ((($$4$lcssa$i)) + 20|0);
          $331 = HEAP32[$330>>2]|0;
          $332 = ($331|0)==(0|0);
          if ($332) {
           $333 = ((($$4$lcssa$i)) + 16|0);
           $334 = HEAP32[$333>>2]|0;
           $335 = ($334|0)==(0|0);
           if ($335) {
            $$3348$i = 0;
            break;
           } else {
            $$1346$i$ph = $334;$$1350$i$ph = $333;
           }
          } else {
           $$1346$i$ph = $331;$$1350$i$ph = $330;
          }
          $$1346$i = $$1346$i$ph;$$1350$i = $$1350$i$ph;
          while(1) {
           $336 = ((($$1346$i)) + 20|0);
           $337 = HEAP32[$336>>2]|0;
           $338 = ($337|0)==(0|0);
           if ($338) {
            $339 = ((($$1346$i)) + 16|0);
            $340 = HEAP32[$339>>2]|0;
            $341 = ($340|0)==(0|0);
            if ($341) {
             break;
            } else {
             $$1346$i$be = $340;$$1350$i$be = $339;
            }
           } else {
            $$1346$i$be = $337;$$1350$i$be = $336;
           }
           $$1346$i = $$1346$i$be;$$1350$i = $$1350$i$be;
          }
          HEAP32[$$1350$i>>2] = 0;
          $$3348$i = $$1346$i;
         } else {
          $326 = ((($$4$lcssa$i)) + 8|0);
          $327 = HEAP32[$326>>2]|0;
          $328 = ((($327)) + 12|0);
          HEAP32[$328>>2] = $324;
          $329 = ((($324)) + 8|0);
          HEAP32[$329>>2] = $327;
          $$3348$i = $324;
         }
        } while(0);
        $342 = ($322|0)==(0|0);
        do {
         if ($342) {
          $425 = $220;
         } else {
          $343 = ((($$4$lcssa$i)) + 28|0);
          $344 = HEAP32[$343>>2]|0;
          $345 = (9632 + ($344<<2)|0);
          $346 = HEAP32[$345>>2]|0;
          $347 = ($$4$lcssa$i|0)==($346|0);
          if ($347) {
           HEAP32[$345>>2] = $$3348$i;
           $cond$i203 = ($$3348$i|0)==(0|0);
           if ($cond$i203) {
            $348 = 1 << $344;
            $349 = $348 ^ -1;
            $350 = $220 & $349;
            HEAP32[(9332)>>2] = $350;
            $425 = $350;
            break;
           }
          } else {
           $351 = ((($322)) + 16|0);
           $352 = HEAP32[$351>>2]|0;
           $353 = ($352|0)==($$4$lcssa$i|0);
           $354 = ((($322)) + 20|0);
           $$sink320 = $353 ? $351 : $354;
           HEAP32[$$sink320>>2] = $$3348$i;
           $355 = ($$3348$i|0)==(0|0);
           if ($355) {
            $425 = $220;
            break;
           }
          }
          $356 = ((($$3348$i)) + 24|0);
          HEAP32[$356>>2] = $322;
          $357 = ((($$4$lcssa$i)) + 16|0);
          $358 = HEAP32[$357>>2]|0;
          $359 = ($358|0)==(0|0);
          if (!($359)) {
           $360 = ((($$3348$i)) + 16|0);
           HEAP32[$360>>2] = $358;
           $361 = ((($358)) + 24|0);
           HEAP32[$361>>2] = $$3348$i;
          }
          $362 = ((($$4$lcssa$i)) + 20|0);
          $363 = HEAP32[$362>>2]|0;
          $364 = ($363|0)==(0|0);
          if ($364) {
           $425 = $220;
          } else {
           $365 = ((($$3348$i)) + 20|0);
           HEAP32[$365>>2] = $363;
           $366 = ((($363)) + 24|0);
           HEAP32[$366>>2] = $$3348$i;
           $425 = $220;
          }
         }
        } while(0);
        $367 = ($$4327$lcssa$i>>>0)<(16);
        L128: do {
         if ($367) {
          $368 = (($$4327$lcssa$i) + ($219))|0;
          $369 = $368 | 3;
          $370 = ((($$4$lcssa$i)) + 4|0);
          HEAP32[$370>>2] = $369;
          $371 = (($$4$lcssa$i) + ($368)|0);
          $372 = ((($371)) + 4|0);
          $373 = HEAP32[$372>>2]|0;
          $374 = $373 | 1;
          HEAP32[$372>>2] = $374;
         } else {
          $375 = $219 | 3;
          $376 = ((($$4$lcssa$i)) + 4|0);
          HEAP32[$376>>2] = $375;
          $377 = $$4327$lcssa$i | 1;
          $378 = ((($319)) + 4|0);
          HEAP32[$378>>2] = $377;
          $379 = (($319) + ($$4327$lcssa$i)|0);
          HEAP32[$379>>2] = $$4327$lcssa$i;
          $380 = $$4327$lcssa$i >>> 3;
          $381 = ($$4327$lcssa$i>>>0)<(256);
          if ($381) {
           $382 = $380 << 1;
           $383 = (9368 + ($382<<2)|0);
           $384 = HEAP32[2332]|0;
           $385 = 1 << $380;
           $386 = $384 & $385;
           $387 = ($386|0)==(0);
           if ($387) {
            $388 = $384 | $385;
            HEAP32[2332] = $388;
            $$pre$i204 = ((($383)) + 8|0);
            $$0344$i = $383;$$pre$phi$i205Z2D = $$pre$i204;
           } else {
            $389 = ((($383)) + 8|0);
            $390 = HEAP32[$389>>2]|0;
            $$0344$i = $390;$$pre$phi$i205Z2D = $389;
           }
           HEAP32[$$pre$phi$i205Z2D>>2] = $319;
           $391 = ((($$0344$i)) + 12|0);
           HEAP32[$391>>2] = $319;
           $392 = ((($319)) + 8|0);
           HEAP32[$392>>2] = $$0344$i;
           $393 = ((($319)) + 12|0);
           HEAP32[$393>>2] = $383;
           break;
          }
          $394 = $$4327$lcssa$i >>> 8;
          $395 = ($394|0)==(0);
          if ($395) {
           $$0338$i = 0;
          } else {
           $396 = ($$4327$lcssa$i>>>0)>(16777215);
           if ($396) {
            $$0338$i = 31;
           } else {
            $397 = (($394) + 1048320)|0;
            $398 = $397 >>> 16;
            $399 = $398 & 8;
            $400 = $394 << $399;
            $401 = (($400) + 520192)|0;
            $402 = $401 >>> 16;
            $403 = $402 & 4;
            $404 = $403 | $399;
            $405 = $400 << $403;
            $406 = (($405) + 245760)|0;
            $407 = $406 >>> 16;
            $408 = $407 & 2;
            $409 = $404 | $408;
            $410 = (14 - ($409))|0;
            $411 = $405 << $408;
            $412 = $411 >>> 15;
            $413 = (($410) + ($412))|0;
            $414 = $413 << 1;
            $415 = (($413) + 7)|0;
            $416 = $$4327$lcssa$i >>> $415;
            $417 = $416 & 1;
            $418 = $417 | $414;
            $$0338$i = $418;
           }
          }
          $419 = (9632 + ($$0338$i<<2)|0);
          $420 = ((($319)) + 28|0);
          HEAP32[$420>>2] = $$0338$i;
          $421 = ((($319)) + 16|0);
          $422 = ((($421)) + 4|0);
          HEAP32[$422>>2] = 0;
          HEAP32[$421>>2] = 0;
          $423 = 1 << $$0338$i;
          $424 = $425 & $423;
          $426 = ($424|0)==(0);
          if ($426) {
           $427 = $425 | $423;
           HEAP32[(9332)>>2] = $427;
           HEAP32[$419>>2] = $319;
           $428 = ((($319)) + 24|0);
           HEAP32[$428>>2] = $419;
           $429 = ((($319)) + 12|0);
           HEAP32[$429>>2] = $319;
           $430 = ((($319)) + 8|0);
           HEAP32[$430>>2] = $319;
           break;
          }
          $431 = HEAP32[$419>>2]|0;
          $432 = ((($431)) + 4|0);
          $433 = HEAP32[$432>>2]|0;
          $434 = $433 & -8;
          $435 = ($434|0)==($$4327$lcssa$i|0);
          L145: do {
           if ($435) {
            $$0321$lcssa$i = $431;
           } else {
            $436 = ($$0338$i|0)==(31);
            $437 = $$0338$i >>> 1;
            $438 = (25 - ($437))|0;
            $439 = $436 ? 0 : $438;
            $440 = $$4327$lcssa$i << $439;
            $$032012$i = $440;$$032111$i = $431;
            while(1) {
             $447 = $$032012$i >>> 31;
             $448 = (((($$032111$i)) + 16|0) + ($447<<2)|0);
             $443 = HEAP32[$448>>2]|0;
             $449 = ($443|0)==(0|0);
             if ($449) {
              break;
             }
             $441 = $$032012$i << 1;
             $442 = ((($443)) + 4|0);
             $444 = HEAP32[$442>>2]|0;
             $445 = $444 & -8;
             $446 = ($445|0)==($$4327$lcssa$i|0);
             if ($446) {
              $$0321$lcssa$i = $443;
              break L145;
             } else {
              $$032012$i = $441;$$032111$i = $443;
             }
            }
            HEAP32[$448>>2] = $319;
            $450 = ((($319)) + 24|0);
            HEAP32[$450>>2] = $$032111$i;
            $451 = ((($319)) + 12|0);
            HEAP32[$451>>2] = $319;
            $452 = ((($319)) + 8|0);
            HEAP32[$452>>2] = $319;
            break L128;
           }
          } while(0);
          $453 = ((($$0321$lcssa$i)) + 8|0);
          $454 = HEAP32[$453>>2]|0;
          $455 = ((($454)) + 12|0);
          HEAP32[$455>>2] = $319;
          HEAP32[$453>>2] = $319;
          $456 = ((($319)) + 8|0);
          HEAP32[$456>>2] = $454;
          $457 = ((($319)) + 12|0);
          HEAP32[$457>>2] = $$0321$lcssa$i;
          $458 = ((($319)) + 24|0);
          HEAP32[$458>>2] = 0;
         }
        } while(0);
        $459 = ((($$4$lcssa$i)) + 8|0);
        $$0 = $459;
        STACKTOP = sp;return ($$0|0);
       } else {
        $$0192 = $219;
       }
      } else {
       $$0192 = $219;
      }
     }
    }
   }
  }
 } while(0);
 $460 = HEAP32[(9336)>>2]|0;
 $461 = ($460>>>0)<($$0192>>>0);
 if (!($461)) {
  $462 = (($460) - ($$0192))|0;
  $463 = HEAP32[(9348)>>2]|0;
  $464 = ($462>>>0)>(15);
  if ($464) {
   $465 = (($463) + ($$0192)|0);
   HEAP32[(9348)>>2] = $465;
   HEAP32[(9336)>>2] = $462;
   $466 = $462 | 1;
   $467 = ((($465)) + 4|0);
   HEAP32[$467>>2] = $466;
   $468 = (($463) + ($460)|0);
   HEAP32[$468>>2] = $462;
   $469 = $$0192 | 3;
   $470 = ((($463)) + 4|0);
   HEAP32[$470>>2] = $469;
  } else {
   HEAP32[(9336)>>2] = 0;
   HEAP32[(9348)>>2] = 0;
   $471 = $460 | 3;
   $472 = ((($463)) + 4|0);
   HEAP32[$472>>2] = $471;
   $473 = (($463) + ($460)|0);
   $474 = ((($473)) + 4|0);
   $475 = HEAP32[$474>>2]|0;
   $476 = $475 | 1;
   HEAP32[$474>>2] = $476;
  }
  $477 = ((($463)) + 8|0);
  $$0 = $477;
  STACKTOP = sp;return ($$0|0);
 }
 $478 = HEAP32[(9340)>>2]|0;
 $479 = ($478>>>0)>($$0192>>>0);
 if ($479) {
  $480 = (($478) - ($$0192))|0;
  HEAP32[(9340)>>2] = $480;
  $481 = HEAP32[(9352)>>2]|0;
  $482 = (($481) + ($$0192)|0);
  HEAP32[(9352)>>2] = $482;
  $483 = $480 | 1;
  $484 = ((($482)) + 4|0);
  HEAP32[$484>>2] = $483;
  $485 = $$0192 | 3;
  $486 = ((($481)) + 4|0);
  HEAP32[$486>>2] = $485;
  $487 = ((($481)) + 8|0);
  $$0 = $487;
  STACKTOP = sp;return ($$0|0);
 }
 $488 = HEAP32[2450]|0;
 $489 = ($488|0)==(0);
 if ($489) {
  HEAP32[(9808)>>2] = 4096;
  HEAP32[(9804)>>2] = 4096;
  HEAP32[(9812)>>2] = -1;
  HEAP32[(9816)>>2] = -1;
  HEAP32[(9820)>>2] = 0;
  HEAP32[(9772)>>2] = 0;
  $490 = $1;
  $491 = $490 & -16;
  $492 = $491 ^ 1431655768;
  HEAP32[2450] = $492;
  $496 = 4096;
 } else {
  $$pre$i195 = HEAP32[(9808)>>2]|0;
  $496 = $$pre$i195;
 }
 $493 = (($$0192) + 48)|0;
 $494 = (($$0192) + 47)|0;
 $495 = (($496) + ($494))|0;
 $497 = (0 - ($496))|0;
 $498 = $495 & $497;
 $499 = ($498>>>0)>($$0192>>>0);
 if (!($499)) {
  $$0 = 0;
  STACKTOP = sp;return ($$0|0);
 }
 $500 = HEAP32[(9768)>>2]|0;
 $501 = ($500|0)==(0);
 if (!($501)) {
  $502 = HEAP32[(9760)>>2]|0;
  $503 = (($502) + ($498))|0;
  $504 = ($503>>>0)<=($502>>>0);
  $505 = ($503>>>0)>($500>>>0);
  $or$cond1$i = $504 | $505;
  if ($or$cond1$i) {
   $$0 = 0;
   STACKTOP = sp;return ($$0|0);
  }
 }
 $506 = HEAP32[(9772)>>2]|0;
 $507 = $506 & 4;
 $508 = ($507|0)==(0);
 L178: do {
  if ($508) {
   $509 = HEAP32[(9352)>>2]|0;
   $510 = ($509|0)==(0|0);
   L180: do {
    if ($510) {
     label = 128;
    } else {
     $$0$i20$i = (9776);
     while(1) {
      $511 = HEAP32[$$0$i20$i>>2]|0;
      $512 = ($511>>>0)>($509>>>0);
      if (!($512)) {
       $513 = ((($$0$i20$i)) + 4|0);
       $514 = HEAP32[$513>>2]|0;
       $515 = (($511) + ($514)|0);
       $516 = ($515>>>0)>($509>>>0);
       if ($516) {
        break;
       }
      }
      $517 = ((($$0$i20$i)) + 8|0);
      $518 = HEAP32[$517>>2]|0;
      $519 = ($518|0)==(0|0);
      if ($519) {
       label = 128;
       break L180;
      } else {
       $$0$i20$i = $518;
      }
     }
     $542 = (($495) - ($478))|0;
     $543 = $542 & $497;
     $544 = ($543>>>0)<(2147483647);
     if ($544) {
      $545 = ((($$0$i20$i)) + 4|0);
      $546 = (_sbrk(($543|0))|0);
      $547 = HEAP32[$$0$i20$i>>2]|0;
      $548 = HEAP32[$545>>2]|0;
      $549 = (($547) + ($548)|0);
      $550 = ($546|0)==($549|0);
      if ($550) {
       $551 = ($546|0)==((-1)|0);
       if ($551) {
        $$2234243136$i = $543;
       } else {
        $$723947$i = $543;$$748$i = $546;
        label = 145;
        break L178;
       }
      } else {
       $$2247$ph$i = $546;$$2253$ph$i = $543;
       label = 136;
      }
     } else {
      $$2234243136$i = 0;
     }
    }
   } while(0);
   do {
    if ((label|0) == 128) {
     $520 = (_sbrk(0)|0);
     $521 = ($520|0)==((-1)|0);
     if ($521) {
      $$2234243136$i = 0;
     } else {
      $522 = $520;
      $523 = HEAP32[(9804)>>2]|0;
      $524 = (($523) + -1)|0;
      $525 = $524 & $522;
      $526 = ($525|0)==(0);
      $527 = (($524) + ($522))|0;
      $528 = (0 - ($523))|0;
      $529 = $527 & $528;
      $530 = (($529) - ($522))|0;
      $531 = $526 ? 0 : $530;
      $spec$select49$i = (($531) + ($498))|0;
      $532 = HEAP32[(9760)>>2]|0;
      $533 = (($spec$select49$i) + ($532))|0;
      $534 = ($spec$select49$i>>>0)>($$0192>>>0);
      $535 = ($spec$select49$i>>>0)<(2147483647);
      $or$cond$i = $534 & $535;
      if ($or$cond$i) {
       $536 = HEAP32[(9768)>>2]|0;
       $537 = ($536|0)==(0);
       if (!($537)) {
        $538 = ($533>>>0)<=($532>>>0);
        $539 = ($533>>>0)>($536>>>0);
        $or$cond2$i = $538 | $539;
        if ($or$cond2$i) {
         $$2234243136$i = 0;
         break;
        }
       }
       $540 = (_sbrk(($spec$select49$i|0))|0);
       $541 = ($540|0)==($520|0);
       if ($541) {
        $$723947$i = $spec$select49$i;$$748$i = $520;
        label = 145;
        break L178;
       } else {
        $$2247$ph$i = $540;$$2253$ph$i = $spec$select49$i;
        label = 136;
       }
      } else {
       $$2234243136$i = 0;
      }
     }
    }
   } while(0);
   do {
    if ((label|0) == 136) {
     $552 = (0 - ($$2253$ph$i))|0;
     $553 = ($$2247$ph$i|0)!=((-1)|0);
     $554 = ($$2253$ph$i>>>0)<(2147483647);
     $or$cond7$i = $554 & $553;
     $555 = ($493>>>0)>($$2253$ph$i>>>0);
     $or$cond6$i = $555 & $or$cond7$i;
     if (!($or$cond6$i)) {
      $565 = ($$2247$ph$i|0)==((-1)|0);
      if ($565) {
       $$2234243136$i = 0;
       break;
      } else {
       $$723947$i = $$2253$ph$i;$$748$i = $$2247$ph$i;
       label = 145;
       break L178;
      }
     }
     $556 = HEAP32[(9808)>>2]|0;
     $557 = (($494) - ($$2253$ph$i))|0;
     $558 = (($557) + ($556))|0;
     $559 = (0 - ($556))|0;
     $560 = $558 & $559;
     $561 = ($560>>>0)<(2147483647);
     if (!($561)) {
      $$723947$i = $$2253$ph$i;$$748$i = $$2247$ph$i;
      label = 145;
      break L178;
     }
     $562 = (_sbrk(($560|0))|0);
     $563 = ($562|0)==((-1)|0);
     if ($563) {
      (_sbrk(($552|0))|0);
      $$2234243136$i = 0;
      break;
     } else {
      $564 = (($560) + ($$2253$ph$i))|0;
      $$723947$i = $564;$$748$i = $$2247$ph$i;
      label = 145;
      break L178;
     }
    }
   } while(0);
   $566 = HEAP32[(9772)>>2]|0;
   $567 = $566 | 4;
   HEAP32[(9772)>>2] = $567;
   $$4236$i = $$2234243136$i;
   label = 143;
  } else {
   $$4236$i = 0;
   label = 143;
  }
 } while(0);
 if ((label|0) == 143) {
  $568 = ($498>>>0)<(2147483647);
  if ($568) {
   $569 = (_sbrk(($498|0))|0);
   $570 = (_sbrk(0)|0);
   $571 = ($569|0)!=((-1)|0);
   $572 = ($570|0)!=((-1)|0);
   $or$cond5$i = $571 & $572;
   $573 = ($569>>>0)<($570>>>0);
   $or$cond8$i = $573 & $or$cond5$i;
   $574 = $570;
   $575 = $569;
   $576 = (($574) - ($575))|0;
   $577 = (($$0192) + 40)|0;
   $578 = ($576>>>0)>($577>>>0);
   $spec$select9$i = $578 ? $576 : $$4236$i;
   $or$cond8$not$i = $or$cond8$i ^ 1;
   $579 = ($569|0)==((-1)|0);
   $not$$i = $578 ^ 1;
   $580 = $579 | $not$$i;
   $or$cond50$i = $580 | $or$cond8$not$i;
   if (!($or$cond50$i)) {
    $$723947$i = $spec$select9$i;$$748$i = $569;
    label = 145;
   }
  }
 }
 if ((label|0) == 145) {
  $581 = HEAP32[(9760)>>2]|0;
  $582 = (($581) + ($$723947$i))|0;
  HEAP32[(9760)>>2] = $582;
  $583 = HEAP32[(9764)>>2]|0;
  $584 = ($582>>>0)>($583>>>0);
  if ($584) {
   HEAP32[(9764)>>2] = $582;
  }
  $585 = HEAP32[(9352)>>2]|0;
  $586 = ($585|0)==(0|0);
  L215: do {
   if ($586) {
    $587 = HEAP32[(9344)>>2]|0;
    $588 = ($587|0)==(0|0);
    $589 = ($$748$i>>>0)<($587>>>0);
    $or$cond11$i = $588 | $589;
    if ($or$cond11$i) {
     HEAP32[(9344)>>2] = $$748$i;
    }
    HEAP32[(9776)>>2] = $$748$i;
    HEAP32[(9780)>>2] = $$723947$i;
    HEAP32[(9788)>>2] = 0;
    $590 = HEAP32[2450]|0;
    HEAP32[(9364)>>2] = $590;
    HEAP32[(9360)>>2] = -1;
    HEAP32[(9380)>>2] = (9368);
    HEAP32[(9376)>>2] = (9368);
    HEAP32[(9388)>>2] = (9376);
    HEAP32[(9384)>>2] = (9376);
    HEAP32[(9396)>>2] = (9384);
    HEAP32[(9392)>>2] = (9384);
    HEAP32[(9404)>>2] = (9392);
    HEAP32[(9400)>>2] = (9392);
    HEAP32[(9412)>>2] = (9400);
    HEAP32[(9408)>>2] = (9400);
    HEAP32[(9420)>>2] = (9408);
    HEAP32[(9416)>>2] = (9408);
    HEAP32[(9428)>>2] = (9416);
    HEAP32[(9424)>>2] = (9416);
    HEAP32[(9436)>>2] = (9424);
    HEAP32[(9432)>>2] = (9424);
    HEAP32[(9444)>>2] = (9432);
    HEAP32[(9440)>>2] = (9432);
    HEAP32[(9452)>>2] = (9440);
    HEAP32[(9448)>>2] = (9440);
    HEAP32[(9460)>>2] = (9448);
    HEAP32[(9456)>>2] = (9448);
    HEAP32[(9468)>>2] = (9456);
    HEAP32[(9464)>>2] = (9456);
    HEAP32[(9476)>>2] = (9464);
    HEAP32[(9472)>>2] = (9464);
    HEAP32[(9484)>>2] = (9472);
    HEAP32[(9480)>>2] = (9472);
    HEAP32[(9492)>>2] = (9480);
    HEAP32[(9488)>>2] = (9480);
    HEAP32[(9500)>>2] = (9488);
    HEAP32[(9496)>>2] = (9488);
    HEAP32[(9508)>>2] = (9496);
    HEAP32[(9504)>>2] = (9496);
    HEAP32[(9516)>>2] = (9504);
    HEAP32[(9512)>>2] = (9504);
    HEAP32[(9524)>>2] = (9512);
    HEAP32[(9520)>>2] = (9512);
    HEAP32[(9532)>>2] = (9520);
    HEAP32[(9528)>>2] = (9520);
    HEAP32[(9540)>>2] = (9528);
    HEAP32[(9536)>>2] = (9528);
    HEAP32[(9548)>>2] = (9536);
    HEAP32[(9544)>>2] = (9536);
    HEAP32[(9556)>>2] = (9544);
    HEAP32[(9552)>>2] = (9544);
    HEAP32[(9564)>>2] = (9552);
    HEAP32[(9560)>>2] = (9552);
    HEAP32[(9572)>>2] = (9560);
    HEAP32[(9568)>>2] = (9560);
    HEAP32[(9580)>>2] = (9568);
    HEAP32[(9576)>>2] = (9568);
    HEAP32[(9588)>>2] = (9576);
    HEAP32[(9584)>>2] = (9576);
    HEAP32[(9596)>>2] = (9584);
    HEAP32[(9592)>>2] = (9584);
    HEAP32[(9604)>>2] = (9592);
    HEAP32[(9600)>>2] = (9592);
    HEAP32[(9612)>>2] = (9600);
    HEAP32[(9608)>>2] = (9600);
    HEAP32[(9620)>>2] = (9608);
    HEAP32[(9616)>>2] = (9608);
    HEAP32[(9628)>>2] = (9616);
    HEAP32[(9624)>>2] = (9616);
    $591 = (($$723947$i) + -40)|0;
    $592 = ((($$748$i)) + 8|0);
    $593 = $592;
    $594 = $593 & 7;
    $595 = ($594|0)==(0);
    $596 = (0 - ($593))|0;
    $597 = $596 & 7;
    $598 = $595 ? 0 : $597;
    $599 = (($$748$i) + ($598)|0);
    $600 = (($591) - ($598))|0;
    HEAP32[(9352)>>2] = $599;
    HEAP32[(9340)>>2] = $600;
    $601 = $600 | 1;
    $602 = ((($599)) + 4|0);
    HEAP32[$602>>2] = $601;
    $603 = (($$748$i) + ($591)|0);
    $604 = ((($603)) + 4|0);
    HEAP32[$604>>2] = 40;
    $605 = HEAP32[(9816)>>2]|0;
    HEAP32[(9356)>>2] = $605;
   } else {
    $$024372$i = (9776);
    while(1) {
     $606 = HEAP32[$$024372$i>>2]|0;
     $607 = ((($$024372$i)) + 4|0);
     $608 = HEAP32[$607>>2]|0;
     $609 = (($606) + ($608)|0);
     $610 = ($$748$i|0)==($609|0);
     if ($610) {
      label = 154;
      break;
     }
     $611 = ((($$024372$i)) + 8|0);
     $612 = HEAP32[$611>>2]|0;
     $613 = ($612|0)==(0|0);
     if ($613) {
      break;
     } else {
      $$024372$i = $612;
     }
    }
    if ((label|0) == 154) {
     $614 = ((($$024372$i)) + 4|0);
     $615 = ((($$024372$i)) + 12|0);
     $616 = HEAP32[$615>>2]|0;
     $617 = $616 & 8;
     $618 = ($617|0)==(0);
     if ($618) {
      $619 = ($606>>>0)<=($585>>>0);
      $620 = ($$748$i>>>0)>($585>>>0);
      $or$cond51$i = $620 & $619;
      if ($or$cond51$i) {
       $621 = (($608) + ($$723947$i))|0;
       HEAP32[$614>>2] = $621;
       $622 = HEAP32[(9340)>>2]|0;
       $623 = (($622) + ($$723947$i))|0;
       $624 = ((($585)) + 8|0);
       $625 = $624;
       $626 = $625 & 7;
       $627 = ($626|0)==(0);
       $628 = (0 - ($625))|0;
       $629 = $628 & 7;
       $630 = $627 ? 0 : $629;
       $631 = (($585) + ($630)|0);
       $632 = (($623) - ($630))|0;
       HEAP32[(9352)>>2] = $631;
       HEAP32[(9340)>>2] = $632;
       $633 = $632 | 1;
       $634 = ((($631)) + 4|0);
       HEAP32[$634>>2] = $633;
       $635 = (($585) + ($623)|0);
       $636 = ((($635)) + 4|0);
       HEAP32[$636>>2] = 40;
       $637 = HEAP32[(9816)>>2]|0;
       HEAP32[(9356)>>2] = $637;
       break;
      }
     }
    }
    $638 = HEAP32[(9344)>>2]|0;
    $639 = ($$748$i>>>0)<($638>>>0);
    if ($639) {
     HEAP32[(9344)>>2] = $$748$i;
    }
    $640 = (($$748$i) + ($$723947$i)|0);
    $$124471$i = (9776);
    while(1) {
     $641 = HEAP32[$$124471$i>>2]|0;
     $642 = ($641|0)==($640|0);
     if ($642) {
      label = 162;
      break;
     }
     $643 = ((($$124471$i)) + 8|0);
     $644 = HEAP32[$643>>2]|0;
     $645 = ($644|0)==(0|0);
     if ($645) {
      break;
     } else {
      $$124471$i = $644;
     }
    }
    if ((label|0) == 162) {
     $646 = ((($$124471$i)) + 12|0);
     $647 = HEAP32[$646>>2]|0;
     $648 = $647 & 8;
     $649 = ($648|0)==(0);
     if ($649) {
      HEAP32[$$124471$i>>2] = $$748$i;
      $650 = ((($$124471$i)) + 4|0);
      $651 = HEAP32[$650>>2]|0;
      $652 = (($651) + ($$723947$i))|0;
      HEAP32[$650>>2] = $652;
      $653 = ((($$748$i)) + 8|0);
      $654 = $653;
      $655 = $654 & 7;
      $656 = ($655|0)==(0);
      $657 = (0 - ($654))|0;
      $658 = $657 & 7;
      $659 = $656 ? 0 : $658;
      $660 = (($$748$i) + ($659)|0);
      $661 = ((($640)) + 8|0);
      $662 = $661;
      $663 = $662 & 7;
      $664 = ($663|0)==(0);
      $665 = (0 - ($662))|0;
      $666 = $665 & 7;
      $667 = $664 ? 0 : $666;
      $668 = (($640) + ($667)|0);
      $669 = $668;
      $670 = $660;
      $671 = (($669) - ($670))|0;
      $672 = (($660) + ($$0192)|0);
      $673 = (($671) - ($$0192))|0;
      $674 = $$0192 | 3;
      $675 = ((($660)) + 4|0);
      HEAP32[$675>>2] = $674;
      $676 = ($585|0)==($668|0);
      L238: do {
       if ($676) {
        $677 = HEAP32[(9340)>>2]|0;
        $678 = (($677) + ($673))|0;
        HEAP32[(9340)>>2] = $678;
        HEAP32[(9352)>>2] = $672;
        $679 = $678 | 1;
        $680 = ((($672)) + 4|0);
        HEAP32[$680>>2] = $679;
       } else {
        $681 = HEAP32[(9348)>>2]|0;
        $682 = ($681|0)==($668|0);
        if ($682) {
         $683 = HEAP32[(9336)>>2]|0;
         $684 = (($683) + ($673))|0;
         HEAP32[(9336)>>2] = $684;
         HEAP32[(9348)>>2] = $672;
         $685 = $684 | 1;
         $686 = ((($672)) + 4|0);
         HEAP32[$686>>2] = $685;
         $687 = (($672) + ($684)|0);
         HEAP32[$687>>2] = $684;
         break;
        }
        $688 = ((($668)) + 4|0);
        $689 = HEAP32[$688>>2]|0;
        $690 = $689 & 3;
        $691 = ($690|0)==(1);
        if ($691) {
         $692 = $689 & -8;
         $693 = $689 >>> 3;
         $694 = ($689>>>0)<(256);
         L246: do {
          if ($694) {
           $695 = ((($668)) + 8|0);
           $696 = HEAP32[$695>>2]|0;
           $697 = ((($668)) + 12|0);
           $698 = HEAP32[$697>>2]|0;
           $699 = ($698|0)==($696|0);
           if ($699) {
            $700 = 1 << $693;
            $701 = $700 ^ -1;
            $702 = HEAP32[2332]|0;
            $703 = $702 & $701;
            HEAP32[2332] = $703;
            break;
           } else {
            $704 = ((($696)) + 12|0);
            HEAP32[$704>>2] = $698;
            $705 = ((($698)) + 8|0);
            HEAP32[$705>>2] = $696;
            break;
           }
          } else {
           $706 = ((($668)) + 24|0);
           $707 = HEAP32[$706>>2]|0;
           $708 = ((($668)) + 12|0);
           $709 = HEAP32[$708>>2]|0;
           $710 = ($709|0)==($668|0);
           do {
            if ($710) {
             $715 = ((($668)) + 16|0);
             $716 = ((($715)) + 4|0);
             $717 = HEAP32[$716>>2]|0;
             $718 = ($717|0)==(0|0);
             if ($718) {
              $719 = HEAP32[$715>>2]|0;
              $720 = ($719|0)==(0|0);
              if ($720) {
               $$3$i$i = 0;
               break;
              } else {
               $$1263$i$i$ph = $719;$$1265$i$i$ph = $715;
              }
             } else {
              $$1263$i$i$ph = $717;$$1265$i$i$ph = $716;
             }
             $$1263$i$i = $$1263$i$i$ph;$$1265$i$i = $$1265$i$i$ph;
             while(1) {
              $721 = ((($$1263$i$i)) + 20|0);
              $722 = HEAP32[$721>>2]|0;
              $723 = ($722|0)==(0|0);
              if ($723) {
               $724 = ((($$1263$i$i)) + 16|0);
               $725 = HEAP32[$724>>2]|0;
               $726 = ($725|0)==(0|0);
               if ($726) {
                break;
               } else {
                $$1263$i$i$be = $725;$$1265$i$i$be = $724;
               }
              } else {
               $$1263$i$i$be = $722;$$1265$i$i$be = $721;
              }
              $$1263$i$i = $$1263$i$i$be;$$1265$i$i = $$1265$i$i$be;
             }
             HEAP32[$$1265$i$i>>2] = 0;
             $$3$i$i = $$1263$i$i;
            } else {
             $711 = ((($668)) + 8|0);
             $712 = HEAP32[$711>>2]|0;
             $713 = ((($712)) + 12|0);
             HEAP32[$713>>2] = $709;
             $714 = ((($709)) + 8|0);
             HEAP32[$714>>2] = $712;
             $$3$i$i = $709;
            }
           } while(0);
           $727 = ($707|0)==(0|0);
           if ($727) {
            break;
           }
           $728 = ((($668)) + 28|0);
           $729 = HEAP32[$728>>2]|0;
           $730 = (9632 + ($729<<2)|0);
           $731 = HEAP32[$730>>2]|0;
           $732 = ($731|0)==($668|0);
           do {
            if ($732) {
             HEAP32[$730>>2] = $$3$i$i;
             $cond$i$i = ($$3$i$i|0)==(0|0);
             if (!($cond$i$i)) {
              break;
             }
             $733 = 1 << $729;
             $734 = $733 ^ -1;
             $735 = HEAP32[(9332)>>2]|0;
             $736 = $735 & $734;
             HEAP32[(9332)>>2] = $736;
             break L246;
            } else {
             $737 = ((($707)) + 16|0);
             $738 = HEAP32[$737>>2]|0;
             $739 = ($738|0)==($668|0);
             $740 = ((($707)) + 20|0);
             $$sink321 = $739 ? $737 : $740;
             HEAP32[$$sink321>>2] = $$3$i$i;
             $741 = ($$3$i$i|0)==(0|0);
             if ($741) {
              break L246;
             }
            }
           } while(0);
           $742 = ((($$3$i$i)) + 24|0);
           HEAP32[$742>>2] = $707;
           $743 = ((($668)) + 16|0);
           $744 = HEAP32[$743>>2]|0;
           $745 = ($744|0)==(0|0);
           if (!($745)) {
            $746 = ((($$3$i$i)) + 16|0);
            HEAP32[$746>>2] = $744;
            $747 = ((($744)) + 24|0);
            HEAP32[$747>>2] = $$3$i$i;
           }
           $748 = ((($743)) + 4|0);
           $749 = HEAP32[$748>>2]|0;
           $750 = ($749|0)==(0|0);
           if ($750) {
            break;
           }
           $751 = ((($$3$i$i)) + 20|0);
           HEAP32[$751>>2] = $749;
           $752 = ((($749)) + 24|0);
           HEAP32[$752>>2] = $$3$i$i;
          }
         } while(0);
         $753 = (($668) + ($692)|0);
         $754 = (($692) + ($673))|0;
         $$0$i$i = $753;$$0259$i$i = $754;
        } else {
         $$0$i$i = $668;$$0259$i$i = $673;
        }
        $755 = ((($$0$i$i)) + 4|0);
        $756 = HEAP32[$755>>2]|0;
        $757 = $756 & -2;
        HEAP32[$755>>2] = $757;
        $758 = $$0259$i$i | 1;
        $759 = ((($672)) + 4|0);
        HEAP32[$759>>2] = $758;
        $760 = (($672) + ($$0259$i$i)|0);
        HEAP32[$760>>2] = $$0259$i$i;
        $761 = $$0259$i$i >>> 3;
        $762 = ($$0259$i$i>>>0)<(256);
        if ($762) {
         $763 = $761 << 1;
         $764 = (9368 + ($763<<2)|0);
         $765 = HEAP32[2332]|0;
         $766 = 1 << $761;
         $767 = $765 & $766;
         $768 = ($767|0)==(0);
         if ($768) {
          $769 = $765 | $766;
          HEAP32[2332] = $769;
          $$pre$i16$i = ((($764)) + 8|0);
          $$0267$i$i = $764;$$pre$phi$i17$iZ2D = $$pre$i16$i;
         } else {
          $770 = ((($764)) + 8|0);
          $771 = HEAP32[$770>>2]|0;
          $$0267$i$i = $771;$$pre$phi$i17$iZ2D = $770;
         }
         HEAP32[$$pre$phi$i17$iZ2D>>2] = $672;
         $772 = ((($$0267$i$i)) + 12|0);
         HEAP32[$772>>2] = $672;
         $773 = ((($672)) + 8|0);
         HEAP32[$773>>2] = $$0267$i$i;
         $774 = ((($672)) + 12|0);
         HEAP32[$774>>2] = $764;
         break;
        }
        $775 = $$0259$i$i >>> 8;
        $776 = ($775|0)==(0);
        do {
         if ($776) {
          $$0268$i$i = 0;
         } else {
          $777 = ($$0259$i$i>>>0)>(16777215);
          if ($777) {
           $$0268$i$i = 31;
           break;
          }
          $778 = (($775) + 1048320)|0;
          $779 = $778 >>> 16;
          $780 = $779 & 8;
          $781 = $775 << $780;
          $782 = (($781) + 520192)|0;
          $783 = $782 >>> 16;
          $784 = $783 & 4;
          $785 = $784 | $780;
          $786 = $781 << $784;
          $787 = (($786) + 245760)|0;
          $788 = $787 >>> 16;
          $789 = $788 & 2;
          $790 = $785 | $789;
          $791 = (14 - ($790))|0;
          $792 = $786 << $789;
          $793 = $792 >>> 15;
          $794 = (($791) + ($793))|0;
          $795 = $794 << 1;
          $796 = (($794) + 7)|0;
          $797 = $$0259$i$i >>> $796;
          $798 = $797 & 1;
          $799 = $798 | $795;
          $$0268$i$i = $799;
         }
        } while(0);
        $800 = (9632 + ($$0268$i$i<<2)|0);
        $801 = ((($672)) + 28|0);
        HEAP32[$801>>2] = $$0268$i$i;
        $802 = ((($672)) + 16|0);
        $803 = ((($802)) + 4|0);
        HEAP32[$803>>2] = 0;
        HEAP32[$802>>2] = 0;
        $804 = HEAP32[(9332)>>2]|0;
        $805 = 1 << $$0268$i$i;
        $806 = $804 & $805;
        $807 = ($806|0)==(0);
        if ($807) {
         $808 = $804 | $805;
         HEAP32[(9332)>>2] = $808;
         HEAP32[$800>>2] = $672;
         $809 = ((($672)) + 24|0);
         HEAP32[$809>>2] = $800;
         $810 = ((($672)) + 12|0);
         HEAP32[$810>>2] = $672;
         $811 = ((($672)) + 8|0);
         HEAP32[$811>>2] = $672;
         break;
        }
        $812 = HEAP32[$800>>2]|0;
        $813 = ((($812)) + 4|0);
        $814 = HEAP32[$813>>2]|0;
        $815 = $814 & -8;
        $816 = ($815|0)==($$0259$i$i|0);
        L291: do {
         if ($816) {
          $$0261$lcssa$i$i = $812;
         } else {
          $817 = ($$0268$i$i|0)==(31);
          $818 = $$0268$i$i >>> 1;
          $819 = (25 - ($818))|0;
          $820 = $817 ? 0 : $819;
          $821 = $$0259$i$i << $820;
          $$02604$i$i = $821;$$02613$i$i = $812;
          while(1) {
           $828 = $$02604$i$i >>> 31;
           $829 = (((($$02613$i$i)) + 16|0) + ($828<<2)|0);
           $824 = HEAP32[$829>>2]|0;
           $830 = ($824|0)==(0|0);
           if ($830) {
            break;
           }
           $822 = $$02604$i$i << 1;
           $823 = ((($824)) + 4|0);
           $825 = HEAP32[$823>>2]|0;
           $826 = $825 & -8;
           $827 = ($826|0)==($$0259$i$i|0);
           if ($827) {
            $$0261$lcssa$i$i = $824;
            break L291;
           } else {
            $$02604$i$i = $822;$$02613$i$i = $824;
           }
          }
          HEAP32[$829>>2] = $672;
          $831 = ((($672)) + 24|0);
          HEAP32[$831>>2] = $$02613$i$i;
          $832 = ((($672)) + 12|0);
          HEAP32[$832>>2] = $672;
          $833 = ((($672)) + 8|0);
          HEAP32[$833>>2] = $672;
          break L238;
         }
        } while(0);
        $834 = ((($$0261$lcssa$i$i)) + 8|0);
        $835 = HEAP32[$834>>2]|0;
        $836 = ((($835)) + 12|0);
        HEAP32[$836>>2] = $672;
        HEAP32[$834>>2] = $672;
        $837 = ((($672)) + 8|0);
        HEAP32[$837>>2] = $835;
        $838 = ((($672)) + 12|0);
        HEAP32[$838>>2] = $$0261$lcssa$i$i;
        $839 = ((($672)) + 24|0);
        HEAP32[$839>>2] = 0;
       }
      } while(0);
      $968 = ((($660)) + 8|0);
      $$0 = $968;
      STACKTOP = sp;return ($$0|0);
     }
    }
    $$0$i$i$i = (9776);
    while(1) {
     $840 = HEAP32[$$0$i$i$i>>2]|0;
     $841 = ($840>>>0)>($585>>>0);
     if (!($841)) {
      $842 = ((($$0$i$i$i)) + 4|0);
      $843 = HEAP32[$842>>2]|0;
      $844 = (($840) + ($843)|0);
      $845 = ($844>>>0)>($585>>>0);
      if ($845) {
       break;
      }
     }
     $846 = ((($$0$i$i$i)) + 8|0);
     $847 = HEAP32[$846>>2]|0;
     $$0$i$i$i = $847;
    }
    $848 = ((($844)) + -47|0);
    $849 = ((($848)) + 8|0);
    $850 = $849;
    $851 = $850 & 7;
    $852 = ($851|0)==(0);
    $853 = (0 - ($850))|0;
    $854 = $853 & 7;
    $855 = $852 ? 0 : $854;
    $856 = (($848) + ($855)|0);
    $857 = ((($585)) + 16|0);
    $858 = ($856>>>0)<($857>>>0);
    $859 = $858 ? $585 : $856;
    $860 = ((($859)) + 8|0);
    $861 = ((($859)) + 24|0);
    $862 = (($$723947$i) + -40)|0;
    $863 = ((($$748$i)) + 8|0);
    $864 = $863;
    $865 = $864 & 7;
    $866 = ($865|0)==(0);
    $867 = (0 - ($864))|0;
    $868 = $867 & 7;
    $869 = $866 ? 0 : $868;
    $870 = (($$748$i) + ($869)|0);
    $871 = (($862) - ($869))|0;
    HEAP32[(9352)>>2] = $870;
    HEAP32[(9340)>>2] = $871;
    $872 = $871 | 1;
    $873 = ((($870)) + 4|0);
    HEAP32[$873>>2] = $872;
    $874 = (($$748$i) + ($862)|0);
    $875 = ((($874)) + 4|0);
    HEAP32[$875>>2] = 40;
    $876 = HEAP32[(9816)>>2]|0;
    HEAP32[(9356)>>2] = $876;
    $877 = ((($859)) + 4|0);
    HEAP32[$877>>2] = 27;
    ;HEAP32[$860>>2]=HEAP32[(9776)>>2]|0;HEAP32[$860+4>>2]=HEAP32[(9776)+4>>2]|0;HEAP32[$860+8>>2]=HEAP32[(9776)+8>>2]|0;HEAP32[$860+12>>2]=HEAP32[(9776)+12>>2]|0;
    HEAP32[(9776)>>2] = $$748$i;
    HEAP32[(9780)>>2] = $$723947$i;
    HEAP32[(9788)>>2] = 0;
    HEAP32[(9784)>>2] = $860;
    $879 = $861;
    while(1) {
     $878 = ((($879)) + 4|0);
     HEAP32[$878>>2] = 7;
     $880 = ((($879)) + 8|0);
     $881 = ($880>>>0)<($844>>>0);
     if ($881) {
      $879 = $878;
     } else {
      break;
     }
    }
    $882 = ($859|0)==($585|0);
    if (!($882)) {
     $883 = $859;
     $884 = $585;
     $885 = (($883) - ($884))|0;
     $886 = HEAP32[$877>>2]|0;
     $887 = $886 & -2;
     HEAP32[$877>>2] = $887;
     $888 = $885 | 1;
     $889 = ((($585)) + 4|0);
     HEAP32[$889>>2] = $888;
     HEAP32[$859>>2] = $885;
     $890 = $885 >>> 3;
     $891 = ($885>>>0)<(256);
     if ($891) {
      $892 = $890 << 1;
      $893 = (9368 + ($892<<2)|0);
      $894 = HEAP32[2332]|0;
      $895 = 1 << $890;
      $896 = $894 & $895;
      $897 = ($896|0)==(0);
      if ($897) {
       $898 = $894 | $895;
       HEAP32[2332] = $898;
       $$pre$i$i = ((($893)) + 8|0);
       $$0206$i$i = $893;$$pre$phi$i$iZ2D = $$pre$i$i;
      } else {
       $899 = ((($893)) + 8|0);
       $900 = HEAP32[$899>>2]|0;
       $$0206$i$i = $900;$$pre$phi$i$iZ2D = $899;
      }
      HEAP32[$$pre$phi$i$iZ2D>>2] = $585;
      $901 = ((($$0206$i$i)) + 12|0);
      HEAP32[$901>>2] = $585;
      $902 = ((($585)) + 8|0);
      HEAP32[$902>>2] = $$0206$i$i;
      $903 = ((($585)) + 12|0);
      HEAP32[$903>>2] = $893;
      break;
     }
     $904 = $885 >>> 8;
     $905 = ($904|0)==(0);
     if ($905) {
      $$0207$i$i = 0;
     } else {
      $906 = ($885>>>0)>(16777215);
      if ($906) {
       $$0207$i$i = 31;
      } else {
       $907 = (($904) + 1048320)|0;
       $908 = $907 >>> 16;
       $909 = $908 & 8;
       $910 = $904 << $909;
       $911 = (($910) + 520192)|0;
       $912 = $911 >>> 16;
       $913 = $912 & 4;
       $914 = $913 | $909;
       $915 = $910 << $913;
       $916 = (($915) + 245760)|0;
       $917 = $916 >>> 16;
       $918 = $917 & 2;
       $919 = $914 | $918;
       $920 = (14 - ($919))|0;
       $921 = $915 << $918;
       $922 = $921 >>> 15;
       $923 = (($920) + ($922))|0;
       $924 = $923 << 1;
       $925 = (($923) + 7)|0;
       $926 = $885 >>> $925;
       $927 = $926 & 1;
       $928 = $927 | $924;
       $$0207$i$i = $928;
      }
     }
     $929 = (9632 + ($$0207$i$i<<2)|0);
     $930 = ((($585)) + 28|0);
     HEAP32[$930>>2] = $$0207$i$i;
     $931 = ((($585)) + 20|0);
     HEAP32[$931>>2] = 0;
     HEAP32[$857>>2] = 0;
     $932 = HEAP32[(9332)>>2]|0;
     $933 = 1 << $$0207$i$i;
     $934 = $932 & $933;
     $935 = ($934|0)==(0);
     if ($935) {
      $936 = $932 | $933;
      HEAP32[(9332)>>2] = $936;
      HEAP32[$929>>2] = $585;
      $937 = ((($585)) + 24|0);
      HEAP32[$937>>2] = $929;
      $938 = ((($585)) + 12|0);
      HEAP32[$938>>2] = $585;
      $939 = ((($585)) + 8|0);
      HEAP32[$939>>2] = $585;
      break;
     }
     $940 = HEAP32[$929>>2]|0;
     $941 = ((($940)) + 4|0);
     $942 = HEAP32[$941>>2]|0;
     $943 = $942 & -8;
     $944 = ($943|0)==($885|0);
     L325: do {
      if ($944) {
       $$0202$lcssa$i$i = $940;
      } else {
       $945 = ($$0207$i$i|0)==(31);
       $946 = $$0207$i$i >>> 1;
       $947 = (25 - ($946))|0;
       $948 = $945 ? 0 : $947;
       $949 = $885 << $948;
       $$02014$i$i = $949;$$02023$i$i = $940;
       while(1) {
        $956 = $$02014$i$i >>> 31;
        $957 = (((($$02023$i$i)) + 16|0) + ($956<<2)|0);
        $952 = HEAP32[$957>>2]|0;
        $958 = ($952|0)==(0|0);
        if ($958) {
         break;
        }
        $950 = $$02014$i$i << 1;
        $951 = ((($952)) + 4|0);
        $953 = HEAP32[$951>>2]|0;
        $954 = $953 & -8;
        $955 = ($954|0)==($885|0);
        if ($955) {
         $$0202$lcssa$i$i = $952;
         break L325;
        } else {
         $$02014$i$i = $950;$$02023$i$i = $952;
        }
       }
       HEAP32[$957>>2] = $585;
       $959 = ((($585)) + 24|0);
       HEAP32[$959>>2] = $$02023$i$i;
       $960 = ((($585)) + 12|0);
       HEAP32[$960>>2] = $585;
       $961 = ((($585)) + 8|0);
       HEAP32[$961>>2] = $585;
       break L215;
      }
     } while(0);
     $962 = ((($$0202$lcssa$i$i)) + 8|0);
     $963 = HEAP32[$962>>2]|0;
     $964 = ((($963)) + 12|0);
     HEAP32[$964>>2] = $585;
     HEAP32[$962>>2] = $585;
     $965 = ((($585)) + 8|0);
     HEAP32[$965>>2] = $963;
     $966 = ((($585)) + 12|0);
     HEAP32[$966>>2] = $$0202$lcssa$i$i;
     $967 = ((($585)) + 24|0);
     HEAP32[$967>>2] = 0;
    }
   }
  } while(0);
  $969 = HEAP32[(9340)>>2]|0;
  $970 = ($969>>>0)>($$0192>>>0);
  if ($970) {
   $971 = (($969) - ($$0192))|0;
   HEAP32[(9340)>>2] = $971;
   $972 = HEAP32[(9352)>>2]|0;
   $973 = (($972) + ($$0192)|0);
   HEAP32[(9352)>>2] = $973;
   $974 = $971 | 1;
   $975 = ((($973)) + 4|0);
   HEAP32[$975>>2] = $974;
   $976 = $$0192 | 3;
   $977 = ((($972)) + 4|0);
   HEAP32[$977>>2] = $976;
   $978 = ((($972)) + 8|0);
   $$0 = $978;
   STACKTOP = sp;return ($$0|0);
  }
 }
 $979 = (___errno_location()|0);
 HEAP32[$979>>2] = 12;
 $$0 = 0;
 STACKTOP = sp;return ($$0|0);
}
function _free($0) {
 $0 = $0|0;
 var $$0194$i = 0, $$0194$in$i = 0, $$0346381 = 0, $$0347$lcssa = 0, $$0347380 = 0, $$0359 = 0, $$0366 = 0, $$1 = 0, $$1345 = 0, $$1350 = 0, $$1350$be = 0, $$1350$ph = 0, $$1353 = 0, $$1353$be = 0, $$1353$ph = 0, $$1361 = 0, $$1361$be = 0, $$1361$ph = 0, $$1365 = 0, $$1365$be = 0;
 var $$1365$ph = 0, $$2 = 0, $$3 = 0, $$3363 = 0, $$pre = 0, $$pre$phiZ2D = 0, $$sink = 0, $$sink395 = 0, $1 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0;
 var $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0;
 var $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0;
 var $146 = 0, $147 = 0, $148 = 0, $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0, $161 = 0, $162 = 0, $163 = 0;
 var $164 = 0, $165 = 0, $166 = 0, $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0, $18 = 0, $180 = 0, $181 = 0;
 var $182 = 0, $183 = 0, $184 = 0, $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0, $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0, $198 = 0, $199 = 0, $2 = 0;
 var $20 = 0, $200 = 0, $201 = 0, $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0, $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0, $215 = 0, $216 = 0, $217 = 0;
 var $218 = 0, $219 = 0, $22 = 0, $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0, $226 = 0, $227 = 0, $228 = 0, $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0, $233 = 0, $234 = 0, $235 = 0;
 var $236 = 0, $237 = 0, $238 = 0, $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0, $244 = 0, $245 = 0, $246 = 0, $247 = 0, $248 = 0, $249 = 0, $25 = 0, $250 = 0, $251 = 0, $252 = 0, $253 = 0;
 var $254 = 0, $255 = 0, $256 = 0, $257 = 0, $258 = 0, $259 = 0, $26 = 0, $260 = 0, $261 = 0, $262 = 0, $263 = 0, $264 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0;
 var $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $5 = 0, $50 = 0, $51 = 0;
 var $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $7 = 0;
 var $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = 0, $87 = 0, $88 = 0;
 var $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $cond371 = 0, $cond372 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $1 = ($0|0)==(0|0);
 if ($1) {
  return;
 }
 $2 = ((($0)) + -8|0);
 $3 = HEAP32[(9344)>>2]|0;
 $4 = ((($0)) + -4|0);
 $5 = HEAP32[$4>>2]|0;
 $6 = $5 & -8;
 $7 = (($2) + ($6)|0);
 $8 = $5 & 1;
 $9 = ($8|0)==(0);
 do {
  if ($9) {
   $10 = HEAP32[$2>>2]|0;
   $11 = $5 & 3;
   $12 = ($11|0)==(0);
   if ($12) {
    return;
   }
   $13 = (0 - ($10))|0;
   $14 = (($2) + ($13)|0);
   $15 = (($10) + ($6))|0;
   $16 = ($14>>>0)<($3>>>0);
   if ($16) {
    return;
   }
   $17 = HEAP32[(9348)>>2]|0;
   $18 = ($17|0)==($14|0);
   if ($18) {
    $79 = ((($7)) + 4|0);
    $80 = HEAP32[$79>>2]|0;
    $81 = $80 & 3;
    $82 = ($81|0)==(3);
    if (!($82)) {
     $$1 = $14;$$1345 = $15;$88 = $14;
     break;
    }
    $83 = (($14) + ($15)|0);
    $84 = ((($14)) + 4|0);
    $85 = $15 | 1;
    $86 = $80 & -2;
    HEAP32[(9336)>>2] = $15;
    HEAP32[$79>>2] = $86;
    HEAP32[$84>>2] = $85;
    HEAP32[$83>>2] = $15;
    return;
   }
   $19 = $10 >>> 3;
   $20 = ($10>>>0)<(256);
   if ($20) {
    $21 = ((($14)) + 8|0);
    $22 = HEAP32[$21>>2]|0;
    $23 = ((($14)) + 12|0);
    $24 = HEAP32[$23>>2]|0;
    $25 = ($24|0)==($22|0);
    if ($25) {
     $26 = 1 << $19;
     $27 = $26 ^ -1;
     $28 = HEAP32[2332]|0;
     $29 = $28 & $27;
     HEAP32[2332] = $29;
     $$1 = $14;$$1345 = $15;$88 = $14;
     break;
    } else {
     $30 = ((($22)) + 12|0);
     HEAP32[$30>>2] = $24;
     $31 = ((($24)) + 8|0);
     HEAP32[$31>>2] = $22;
     $$1 = $14;$$1345 = $15;$88 = $14;
     break;
    }
   }
   $32 = ((($14)) + 24|0);
   $33 = HEAP32[$32>>2]|0;
   $34 = ((($14)) + 12|0);
   $35 = HEAP32[$34>>2]|0;
   $36 = ($35|0)==($14|0);
   do {
    if ($36) {
     $41 = ((($14)) + 16|0);
     $42 = ((($41)) + 4|0);
     $43 = HEAP32[$42>>2]|0;
     $44 = ($43|0)==(0|0);
     if ($44) {
      $45 = HEAP32[$41>>2]|0;
      $46 = ($45|0)==(0|0);
      if ($46) {
       $$3 = 0;
       break;
      } else {
       $$1350$ph = $45;$$1353$ph = $41;
      }
     } else {
      $$1350$ph = $43;$$1353$ph = $42;
     }
     $$1350 = $$1350$ph;$$1353 = $$1353$ph;
     while(1) {
      $47 = ((($$1350)) + 20|0);
      $48 = HEAP32[$47>>2]|0;
      $49 = ($48|0)==(0|0);
      if ($49) {
       $50 = ((($$1350)) + 16|0);
       $51 = HEAP32[$50>>2]|0;
       $52 = ($51|0)==(0|0);
       if ($52) {
        break;
       } else {
        $$1350$be = $51;$$1353$be = $50;
       }
      } else {
       $$1350$be = $48;$$1353$be = $47;
      }
      $$1350 = $$1350$be;$$1353 = $$1353$be;
     }
     HEAP32[$$1353>>2] = 0;
     $$3 = $$1350;
    } else {
     $37 = ((($14)) + 8|0);
     $38 = HEAP32[$37>>2]|0;
     $39 = ((($38)) + 12|0);
     HEAP32[$39>>2] = $35;
     $40 = ((($35)) + 8|0);
     HEAP32[$40>>2] = $38;
     $$3 = $35;
    }
   } while(0);
   $53 = ($33|0)==(0|0);
   if ($53) {
    $$1 = $14;$$1345 = $15;$88 = $14;
   } else {
    $54 = ((($14)) + 28|0);
    $55 = HEAP32[$54>>2]|0;
    $56 = (9632 + ($55<<2)|0);
    $57 = HEAP32[$56>>2]|0;
    $58 = ($57|0)==($14|0);
    if ($58) {
     HEAP32[$56>>2] = $$3;
     $cond371 = ($$3|0)==(0|0);
     if ($cond371) {
      $59 = 1 << $55;
      $60 = $59 ^ -1;
      $61 = HEAP32[(9332)>>2]|0;
      $62 = $61 & $60;
      HEAP32[(9332)>>2] = $62;
      $$1 = $14;$$1345 = $15;$88 = $14;
      break;
     }
    } else {
     $63 = ((($33)) + 16|0);
     $64 = HEAP32[$63>>2]|0;
     $65 = ($64|0)==($14|0);
     $66 = ((($33)) + 20|0);
     $$sink = $65 ? $63 : $66;
     HEAP32[$$sink>>2] = $$3;
     $67 = ($$3|0)==(0|0);
     if ($67) {
      $$1 = $14;$$1345 = $15;$88 = $14;
      break;
     }
    }
    $68 = ((($$3)) + 24|0);
    HEAP32[$68>>2] = $33;
    $69 = ((($14)) + 16|0);
    $70 = HEAP32[$69>>2]|0;
    $71 = ($70|0)==(0|0);
    if (!($71)) {
     $72 = ((($$3)) + 16|0);
     HEAP32[$72>>2] = $70;
     $73 = ((($70)) + 24|0);
     HEAP32[$73>>2] = $$3;
    }
    $74 = ((($69)) + 4|0);
    $75 = HEAP32[$74>>2]|0;
    $76 = ($75|0)==(0|0);
    if ($76) {
     $$1 = $14;$$1345 = $15;$88 = $14;
    } else {
     $77 = ((($$3)) + 20|0);
     HEAP32[$77>>2] = $75;
     $78 = ((($75)) + 24|0);
     HEAP32[$78>>2] = $$3;
     $$1 = $14;$$1345 = $15;$88 = $14;
    }
   }
  } else {
   $$1 = $2;$$1345 = $6;$88 = $2;
  }
 } while(0);
 $87 = ($88>>>0)<($7>>>0);
 if (!($87)) {
  return;
 }
 $89 = ((($7)) + 4|0);
 $90 = HEAP32[$89>>2]|0;
 $91 = $90 & 1;
 $92 = ($91|0)==(0);
 if ($92) {
  return;
 }
 $93 = $90 & 2;
 $94 = ($93|0)==(0);
 if ($94) {
  $95 = HEAP32[(9352)>>2]|0;
  $96 = ($95|0)==($7|0);
  if ($96) {
   $97 = HEAP32[(9340)>>2]|0;
   $98 = (($97) + ($$1345))|0;
   HEAP32[(9340)>>2] = $98;
   HEAP32[(9352)>>2] = $$1;
   $99 = $98 | 1;
   $100 = ((($$1)) + 4|0);
   HEAP32[$100>>2] = $99;
   $101 = HEAP32[(9348)>>2]|0;
   $102 = ($$1|0)==($101|0);
   if (!($102)) {
    return;
   }
   HEAP32[(9348)>>2] = 0;
   HEAP32[(9336)>>2] = 0;
   return;
  }
  $103 = HEAP32[(9348)>>2]|0;
  $104 = ($103|0)==($7|0);
  if ($104) {
   $105 = HEAP32[(9336)>>2]|0;
   $106 = (($105) + ($$1345))|0;
   HEAP32[(9336)>>2] = $106;
   HEAP32[(9348)>>2] = $88;
   $107 = $106 | 1;
   $108 = ((($$1)) + 4|0);
   HEAP32[$108>>2] = $107;
   $109 = (($88) + ($106)|0);
   HEAP32[$109>>2] = $106;
   return;
  }
  $110 = $90 & -8;
  $111 = (($110) + ($$1345))|0;
  $112 = $90 >>> 3;
  $113 = ($90>>>0)<(256);
  do {
   if ($113) {
    $114 = ((($7)) + 8|0);
    $115 = HEAP32[$114>>2]|0;
    $116 = ((($7)) + 12|0);
    $117 = HEAP32[$116>>2]|0;
    $118 = ($117|0)==($115|0);
    if ($118) {
     $119 = 1 << $112;
     $120 = $119 ^ -1;
     $121 = HEAP32[2332]|0;
     $122 = $121 & $120;
     HEAP32[2332] = $122;
     break;
    } else {
     $123 = ((($115)) + 12|0);
     HEAP32[$123>>2] = $117;
     $124 = ((($117)) + 8|0);
     HEAP32[$124>>2] = $115;
     break;
    }
   } else {
    $125 = ((($7)) + 24|0);
    $126 = HEAP32[$125>>2]|0;
    $127 = ((($7)) + 12|0);
    $128 = HEAP32[$127>>2]|0;
    $129 = ($128|0)==($7|0);
    do {
     if ($129) {
      $134 = ((($7)) + 16|0);
      $135 = ((($134)) + 4|0);
      $136 = HEAP32[$135>>2]|0;
      $137 = ($136|0)==(0|0);
      if ($137) {
       $138 = HEAP32[$134>>2]|0;
       $139 = ($138|0)==(0|0);
       if ($139) {
        $$3363 = 0;
        break;
       } else {
        $$1361$ph = $138;$$1365$ph = $134;
       }
      } else {
       $$1361$ph = $136;$$1365$ph = $135;
      }
      $$1361 = $$1361$ph;$$1365 = $$1365$ph;
      while(1) {
       $140 = ((($$1361)) + 20|0);
       $141 = HEAP32[$140>>2]|0;
       $142 = ($141|0)==(0|0);
       if ($142) {
        $143 = ((($$1361)) + 16|0);
        $144 = HEAP32[$143>>2]|0;
        $145 = ($144|0)==(0|0);
        if ($145) {
         break;
        } else {
         $$1361$be = $144;$$1365$be = $143;
        }
       } else {
        $$1361$be = $141;$$1365$be = $140;
       }
       $$1361 = $$1361$be;$$1365 = $$1365$be;
      }
      HEAP32[$$1365>>2] = 0;
      $$3363 = $$1361;
     } else {
      $130 = ((($7)) + 8|0);
      $131 = HEAP32[$130>>2]|0;
      $132 = ((($131)) + 12|0);
      HEAP32[$132>>2] = $128;
      $133 = ((($128)) + 8|0);
      HEAP32[$133>>2] = $131;
      $$3363 = $128;
     }
    } while(0);
    $146 = ($126|0)==(0|0);
    if (!($146)) {
     $147 = ((($7)) + 28|0);
     $148 = HEAP32[$147>>2]|0;
     $149 = (9632 + ($148<<2)|0);
     $150 = HEAP32[$149>>2]|0;
     $151 = ($150|0)==($7|0);
     if ($151) {
      HEAP32[$149>>2] = $$3363;
      $cond372 = ($$3363|0)==(0|0);
      if ($cond372) {
       $152 = 1 << $148;
       $153 = $152 ^ -1;
       $154 = HEAP32[(9332)>>2]|0;
       $155 = $154 & $153;
       HEAP32[(9332)>>2] = $155;
       break;
      }
     } else {
      $156 = ((($126)) + 16|0);
      $157 = HEAP32[$156>>2]|0;
      $158 = ($157|0)==($7|0);
      $159 = ((($126)) + 20|0);
      $$sink395 = $158 ? $156 : $159;
      HEAP32[$$sink395>>2] = $$3363;
      $160 = ($$3363|0)==(0|0);
      if ($160) {
       break;
      }
     }
     $161 = ((($$3363)) + 24|0);
     HEAP32[$161>>2] = $126;
     $162 = ((($7)) + 16|0);
     $163 = HEAP32[$162>>2]|0;
     $164 = ($163|0)==(0|0);
     if (!($164)) {
      $165 = ((($$3363)) + 16|0);
      HEAP32[$165>>2] = $163;
      $166 = ((($163)) + 24|0);
      HEAP32[$166>>2] = $$3363;
     }
     $167 = ((($162)) + 4|0);
     $168 = HEAP32[$167>>2]|0;
     $169 = ($168|0)==(0|0);
     if (!($169)) {
      $170 = ((($$3363)) + 20|0);
      HEAP32[$170>>2] = $168;
      $171 = ((($168)) + 24|0);
      HEAP32[$171>>2] = $$3363;
     }
    }
   }
  } while(0);
  $172 = $111 | 1;
  $173 = ((($$1)) + 4|0);
  HEAP32[$173>>2] = $172;
  $174 = (($88) + ($111)|0);
  HEAP32[$174>>2] = $111;
  $175 = HEAP32[(9348)>>2]|0;
  $176 = ($$1|0)==($175|0);
  if ($176) {
   HEAP32[(9336)>>2] = $111;
   return;
  } else {
   $$2 = $111;
  }
 } else {
  $177 = $90 & -2;
  HEAP32[$89>>2] = $177;
  $178 = $$1345 | 1;
  $179 = ((($$1)) + 4|0);
  HEAP32[$179>>2] = $178;
  $180 = (($88) + ($$1345)|0);
  HEAP32[$180>>2] = $$1345;
  $$2 = $$1345;
 }
 $181 = $$2 >>> 3;
 $182 = ($$2>>>0)<(256);
 if ($182) {
  $183 = $181 << 1;
  $184 = (9368 + ($183<<2)|0);
  $185 = HEAP32[2332]|0;
  $186 = 1 << $181;
  $187 = $185 & $186;
  $188 = ($187|0)==(0);
  if ($188) {
   $189 = $185 | $186;
   HEAP32[2332] = $189;
   $$pre = ((($184)) + 8|0);
   $$0366 = $184;$$pre$phiZ2D = $$pre;
  } else {
   $190 = ((($184)) + 8|0);
   $191 = HEAP32[$190>>2]|0;
   $$0366 = $191;$$pre$phiZ2D = $190;
  }
  HEAP32[$$pre$phiZ2D>>2] = $$1;
  $192 = ((($$0366)) + 12|0);
  HEAP32[$192>>2] = $$1;
  $193 = ((($$1)) + 8|0);
  HEAP32[$193>>2] = $$0366;
  $194 = ((($$1)) + 12|0);
  HEAP32[$194>>2] = $184;
  return;
 }
 $195 = $$2 >>> 8;
 $196 = ($195|0)==(0);
 if ($196) {
  $$0359 = 0;
 } else {
  $197 = ($$2>>>0)>(16777215);
  if ($197) {
   $$0359 = 31;
  } else {
   $198 = (($195) + 1048320)|0;
   $199 = $198 >>> 16;
   $200 = $199 & 8;
   $201 = $195 << $200;
   $202 = (($201) + 520192)|0;
   $203 = $202 >>> 16;
   $204 = $203 & 4;
   $205 = $204 | $200;
   $206 = $201 << $204;
   $207 = (($206) + 245760)|0;
   $208 = $207 >>> 16;
   $209 = $208 & 2;
   $210 = $205 | $209;
   $211 = (14 - ($210))|0;
   $212 = $206 << $209;
   $213 = $212 >>> 15;
   $214 = (($211) + ($213))|0;
   $215 = $214 << 1;
   $216 = (($214) + 7)|0;
   $217 = $$2 >>> $216;
   $218 = $217 & 1;
   $219 = $218 | $215;
   $$0359 = $219;
  }
 }
 $220 = (9632 + ($$0359<<2)|0);
 $221 = ((($$1)) + 28|0);
 HEAP32[$221>>2] = $$0359;
 $222 = ((($$1)) + 16|0);
 $223 = ((($$1)) + 20|0);
 HEAP32[$223>>2] = 0;
 HEAP32[$222>>2] = 0;
 $224 = HEAP32[(9332)>>2]|0;
 $225 = 1 << $$0359;
 $226 = $224 & $225;
 $227 = ($226|0)==(0);
 L112: do {
  if ($227) {
   $228 = $224 | $225;
   HEAP32[(9332)>>2] = $228;
   HEAP32[$220>>2] = $$1;
   $229 = ((($$1)) + 24|0);
   HEAP32[$229>>2] = $220;
   $230 = ((($$1)) + 12|0);
   HEAP32[$230>>2] = $$1;
   $231 = ((($$1)) + 8|0);
   HEAP32[$231>>2] = $$1;
  } else {
   $232 = HEAP32[$220>>2]|0;
   $233 = ((($232)) + 4|0);
   $234 = HEAP32[$233>>2]|0;
   $235 = $234 & -8;
   $236 = ($235|0)==($$2|0);
   L115: do {
    if ($236) {
     $$0347$lcssa = $232;
    } else {
     $237 = ($$0359|0)==(31);
     $238 = $$0359 >>> 1;
     $239 = (25 - ($238))|0;
     $240 = $237 ? 0 : $239;
     $241 = $$2 << $240;
     $$0346381 = $241;$$0347380 = $232;
     while(1) {
      $248 = $$0346381 >>> 31;
      $249 = (((($$0347380)) + 16|0) + ($248<<2)|0);
      $244 = HEAP32[$249>>2]|0;
      $250 = ($244|0)==(0|0);
      if ($250) {
       break;
      }
      $242 = $$0346381 << 1;
      $243 = ((($244)) + 4|0);
      $245 = HEAP32[$243>>2]|0;
      $246 = $245 & -8;
      $247 = ($246|0)==($$2|0);
      if ($247) {
       $$0347$lcssa = $244;
       break L115;
      } else {
       $$0346381 = $242;$$0347380 = $244;
      }
     }
     HEAP32[$249>>2] = $$1;
     $251 = ((($$1)) + 24|0);
     HEAP32[$251>>2] = $$0347380;
     $252 = ((($$1)) + 12|0);
     HEAP32[$252>>2] = $$1;
     $253 = ((($$1)) + 8|0);
     HEAP32[$253>>2] = $$1;
     break L112;
    }
   } while(0);
   $254 = ((($$0347$lcssa)) + 8|0);
   $255 = HEAP32[$254>>2]|0;
   $256 = ((($255)) + 12|0);
   HEAP32[$256>>2] = $$1;
   HEAP32[$254>>2] = $$1;
   $257 = ((($$1)) + 8|0);
   HEAP32[$257>>2] = $255;
   $258 = ((($$1)) + 12|0);
   HEAP32[$258>>2] = $$0347$lcssa;
   $259 = ((($$1)) + 24|0);
   HEAP32[$259>>2] = 0;
  }
 } while(0);
 $260 = HEAP32[(9360)>>2]|0;
 $261 = (($260) + -1)|0;
 HEAP32[(9360)>>2] = $261;
 $262 = ($261|0)==(0);
 if (!($262)) {
  return;
 }
 $$0194$in$i = (9784);
 while(1) {
  $$0194$i = HEAP32[$$0194$in$i>>2]|0;
  $263 = ($$0194$i|0)==(0|0);
  $264 = ((($$0194$i)) + 8|0);
  if ($263) {
   break;
  } else {
   $$0194$in$i = $264;
  }
 }
 HEAP32[(9360)>>2] = -1;
 return;
}
function _realloc($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$1 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $3 = 0, $4 = 0, $5 = 0;
 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = ($0|0)==(0|0);
 if ($2) {
  $3 = (_malloc($1)|0);
  $$1 = $3;
  return ($$1|0);
 }
 $4 = ($1>>>0)>(4294967231);
 if ($4) {
  $5 = (___errno_location()|0);
  HEAP32[$5>>2] = 12;
  $$1 = 0;
  return ($$1|0);
 }
 $6 = ($1>>>0)<(11);
 $7 = (($1) + 11)|0;
 $8 = $7 & -8;
 $9 = $6 ? 16 : $8;
 $10 = ((($0)) + -8|0);
 $11 = (_try_realloc_chunk($10,$9)|0);
 $12 = ($11|0)==(0|0);
 if (!($12)) {
  $13 = ((($11)) + 8|0);
  $$1 = $13;
  return ($$1|0);
 }
 $14 = (_malloc($1)|0);
 $15 = ($14|0)==(0|0);
 if ($15) {
  $$1 = 0;
  return ($$1|0);
 }
 $16 = ((($0)) + -4|0);
 $17 = HEAP32[$16>>2]|0;
 $18 = $17 & -8;
 $19 = $17 & 3;
 $20 = ($19|0)==(0);
 $21 = $20 ? 8 : 4;
 $22 = (($18) - ($21))|0;
 $23 = ($22>>>0)<($1>>>0);
 $24 = $23 ? $22 : $1;
 (_memcpy(($14|0),($0|0),($24|0))|0);
 _free($0);
 $$1 = $14;
 return ($$1|0);
}
function _try_realloc_chunk($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$1245 = 0, $$1245$be = 0, $$1245$ph = 0, $$1248 = 0, $$1248$be = 0, $$1248$ph = 0, $$2 = 0, $$3 = 0, $$sink = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0;
 var $11 = 0, $110 = 0, $111 = 0, $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0;
 var $128 = 0, $129 = 0, $13 = 0, $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0;
 var $146 = 0, $147 = 0, $148 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $2 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0;
 var $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0;
 var $49 = 0, $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0;
 var $67 = 0, $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0;
 var $85 = 0, $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $cond = 0, $storemerge = 0, $storemerge1 = 0, label = 0;
 var sp = 0;
 sp = STACKTOP;
 $2 = ((($0)) + 4|0);
 $3 = HEAP32[$2>>2]|0;
 $4 = $3 & -8;
 $5 = (($0) + ($4)|0);
 $6 = $3 & 3;
 $7 = ($6|0)==(0);
 if ($7) {
  $8 = ($1>>>0)<(256);
  if ($8) {
   $$2 = 0;
   return ($$2|0);
  }
  $9 = (($1) + 4)|0;
  $10 = ($4>>>0)<($9>>>0);
  if (!($10)) {
   $11 = (($4) - ($1))|0;
   $12 = HEAP32[(9808)>>2]|0;
   $13 = $12 << 1;
   $14 = ($11>>>0)>($13>>>0);
   if (!($14)) {
    $$2 = $0;
    return ($$2|0);
   }
  }
  $$2 = 0;
  return ($$2|0);
 }
 $15 = ($4>>>0)<($1>>>0);
 if (!($15)) {
  $16 = (($4) - ($1))|0;
  $17 = ($16>>>0)>(15);
  if (!($17)) {
   $$2 = $0;
   return ($$2|0);
  }
  $18 = (($0) + ($1)|0);
  $19 = $3 & 1;
  $20 = $19 | $1;
  $21 = $20 | 2;
  HEAP32[$2>>2] = $21;
  $22 = ((($18)) + 4|0);
  $23 = $16 | 3;
  HEAP32[$22>>2] = $23;
  $24 = ((($5)) + 4|0);
  $25 = HEAP32[$24>>2]|0;
  $26 = $25 | 1;
  HEAP32[$24>>2] = $26;
  _dispose_chunk($18,$16);
  $$2 = $0;
  return ($$2|0);
 }
 $27 = HEAP32[(9352)>>2]|0;
 $28 = ($27|0)==($5|0);
 if ($28) {
  $29 = HEAP32[(9340)>>2]|0;
  $30 = (($29) + ($4))|0;
  $31 = ($30>>>0)>($1>>>0);
  $32 = (($30) - ($1))|0;
  $33 = (($0) + ($1)|0);
  if (!($31)) {
   $$2 = 0;
   return ($$2|0);
  }
  $34 = $32 | 1;
  $35 = ((($33)) + 4|0);
  $36 = $3 & 1;
  $37 = $36 | $1;
  $38 = $37 | 2;
  HEAP32[$2>>2] = $38;
  HEAP32[$35>>2] = $34;
  HEAP32[(9352)>>2] = $33;
  HEAP32[(9340)>>2] = $32;
  $$2 = $0;
  return ($$2|0);
 }
 $39 = HEAP32[(9348)>>2]|0;
 $40 = ($39|0)==($5|0);
 if ($40) {
  $41 = HEAP32[(9336)>>2]|0;
  $42 = (($41) + ($4))|0;
  $43 = ($42>>>0)<($1>>>0);
  if ($43) {
   $$2 = 0;
   return ($$2|0);
  }
  $44 = (($42) - ($1))|0;
  $45 = ($44>>>0)>(15);
  if ($45) {
   $46 = (($0) + ($1)|0);
   $47 = (($0) + ($42)|0);
   $48 = $3 & 1;
   $49 = $48 | $1;
   $50 = $49 | 2;
   HEAP32[$2>>2] = $50;
   $51 = ((($46)) + 4|0);
   $52 = $44 | 1;
   HEAP32[$51>>2] = $52;
   HEAP32[$47>>2] = $44;
   $53 = ((($47)) + 4|0);
   $54 = HEAP32[$53>>2]|0;
   $55 = $54 & -2;
   HEAP32[$53>>2] = $55;
   $storemerge = $46;$storemerge1 = $44;
  } else {
   $56 = $3 & 1;
   $57 = $56 | $42;
   $58 = $57 | 2;
   HEAP32[$2>>2] = $58;
   $59 = (($0) + ($42)|0);
   $60 = ((($59)) + 4|0);
   $61 = HEAP32[$60>>2]|0;
   $62 = $61 | 1;
   HEAP32[$60>>2] = $62;
   $storemerge = 0;$storemerge1 = 0;
  }
  HEAP32[(9336)>>2] = $storemerge1;
  HEAP32[(9348)>>2] = $storemerge;
  $$2 = $0;
  return ($$2|0);
 }
 $63 = ((($5)) + 4|0);
 $64 = HEAP32[$63>>2]|0;
 $65 = $64 & 2;
 $66 = ($65|0)==(0);
 if (!($66)) {
  $$2 = 0;
  return ($$2|0);
 }
 $67 = $64 & -8;
 $68 = (($67) + ($4))|0;
 $69 = ($68>>>0)<($1>>>0);
 if ($69) {
  $$2 = 0;
  return ($$2|0);
 }
 $70 = (($68) - ($1))|0;
 $71 = $64 >>> 3;
 $72 = ($64>>>0)<(256);
 do {
  if ($72) {
   $73 = ((($5)) + 8|0);
   $74 = HEAP32[$73>>2]|0;
   $75 = ((($5)) + 12|0);
   $76 = HEAP32[$75>>2]|0;
   $77 = ($76|0)==($74|0);
   if ($77) {
    $78 = 1 << $71;
    $79 = $78 ^ -1;
    $80 = HEAP32[2332]|0;
    $81 = $80 & $79;
    HEAP32[2332] = $81;
    break;
   } else {
    $82 = ((($74)) + 12|0);
    HEAP32[$82>>2] = $76;
    $83 = ((($76)) + 8|0);
    HEAP32[$83>>2] = $74;
    break;
   }
  } else {
   $84 = ((($5)) + 24|0);
   $85 = HEAP32[$84>>2]|0;
   $86 = ((($5)) + 12|0);
   $87 = HEAP32[$86>>2]|0;
   $88 = ($87|0)==($5|0);
   do {
    if ($88) {
     $93 = ((($5)) + 16|0);
     $94 = ((($93)) + 4|0);
     $95 = HEAP32[$94>>2]|0;
     $96 = ($95|0)==(0|0);
     if ($96) {
      $97 = HEAP32[$93>>2]|0;
      $98 = ($97|0)==(0|0);
      if ($98) {
       $$3 = 0;
       break;
      } else {
       $$1245$ph = $97;$$1248$ph = $93;
      }
     } else {
      $$1245$ph = $95;$$1248$ph = $94;
     }
     $$1245 = $$1245$ph;$$1248 = $$1248$ph;
     while(1) {
      $99 = ((($$1245)) + 20|0);
      $100 = HEAP32[$99>>2]|0;
      $101 = ($100|0)==(0|0);
      if ($101) {
       $102 = ((($$1245)) + 16|0);
       $103 = HEAP32[$102>>2]|0;
       $104 = ($103|0)==(0|0);
       if ($104) {
        break;
       } else {
        $$1245$be = $103;$$1248$be = $102;
       }
      } else {
       $$1245$be = $100;$$1248$be = $99;
      }
      $$1245 = $$1245$be;$$1248 = $$1248$be;
     }
     HEAP32[$$1248>>2] = 0;
     $$3 = $$1245;
    } else {
     $89 = ((($5)) + 8|0);
     $90 = HEAP32[$89>>2]|0;
     $91 = ((($90)) + 12|0);
     HEAP32[$91>>2] = $87;
     $92 = ((($87)) + 8|0);
     HEAP32[$92>>2] = $90;
     $$3 = $87;
    }
   } while(0);
   $105 = ($85|0)==(0|0);
   if (!($105)) {
    $106 = ((($5)) + 28|0);
    $107 = HEAP32[$106>>2]|0;
    $108 = (9632 + ($107<<2)|0);
    $109 = HEAP32[$108>>2]|0;
    $110 = ($109|0)==($5|0);
    if ($110) {
     HEAP32[$108>>2] = $$3;
     $cond = ($$3|0)==(0|0);
     if ($cond) {
      $111 = 1 << $107;
      $112 = $111 ^ -1;
      $113 = HEAP32[(9332)>>2]|0;
      $114 = $113 & $112;
      HEAP32[(9332)>>2] = $114;
      break;
     }
    } else {
     $115 = ((($85)) + 16|0);
     $116 = HEAP32[$115>>2]|0;
     $117 = ($116|0)==($5|0);
     $118 = ((($85)) + 20|0);
     $$sink = $117 ? $115 : $118;
     HEAP32[$$sink>>2] = $$3;
     $119 = ($$3|0)==(0|0);
     if ($119) {
      break;
     }
    }
    $120 = ((($$3)) + 24|0);
    HEAP32[$120>>2] = $85;
    $121 = ((($5)) + 16|0);
    $122 = HEAP32[$121>>2]|0;
    $123 = ($122|0)==(0|0);
    if (!($123)) {
     $124 = ((($$3)) + 16|0);
     HEAP32[$124>>2] = $122;
     $125 = ((($122)) + 24|0);
     HEAP32[$125>>2] = $$3;
    }
    $126 = ((($121)) + 4|0);
    $127 = HEAP32[$126>>2]|0;
    $128 = ($127|0)==(0|0);
    if (!($128)) {
     $129 = ((($$3)) + 20|0);
     HEAP32[$129>>2] = $127;
     $130 = ((($127)) + 24|0);
     HEAP32[$130>>2] = $$3;
    }
   }
  }
 } while(0);
 $131 = ($70>>>0)<(16);
 if ($131) {
  $132 = $3 & 1;
  $133 = $132 | $68;
  $134 = $133 | 2;
  HEAP32[$2>>2] = $134;
  $135 = (($0) + ($68)|0);
  $136 = ((($135)) + 4|0);
  $137 = HEAP32[$136>>2]|0;
  $138 = $137 | 1;
  HEAP32[$136>>2] = $138;
  $$2 = $0;
  return ($$2|0);
 } else {
  $139 = (($0) + ($1)|0);
  $140 = $3 & 1;
  $141 = $140 | $1;
  $142 = $141 | 2;
  HEAP32[$2>>2] = $142;
  $143 = ((($139)) + 4|0);
  $144 = $70 | 3;
  HEAP32[$143>>2] = $144;
  $145 = (($0) + ($68)|0);
  $146 = ((($145)) + 4|0);
  $147 = HEAP32[$146>>2]|0;
  $148 = $147 | 1;
  HEAP32[$146>>2] = $148;
  _dispose_chunk($139,$70);
  $$2 = $0;
  return ($$2|0);
 }
 return (0)|0;
}
function _dispose_chunk($0,$1) {
 $0 = $0|0;
 $1 = $1|0;
 var $$03649 = 0, $$0365$lcssa = 0, $$03658 = 0, $$0376 = 0, $$0383 = 0, $$1 = 0, $$1363 = 0, $$1371 = 0, $$1371$be = 0, $$1371$ph = 0, $$1374 = 0, $$1374$be = 0, $$1374$ph = 0, $$1378 = 0, $$1378$be = 0, $$1378$ph = 0, $$1382 = 0, $$1382$be = 0, $$1382$ph = 0, $$2 = 0;
 var $$3 = 0, $$3380 = 0, $$pre = 0, $$pre$phiZ2D = 0, $$sink = 0, $$sink24 = 0, $10 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = 0, $109 = 0, $11 = 0, $110 = 0, $111 = 0;
 var $112 = 0, $113 = 0, $114 = 0, $115 = 0, $116 = 0, $117 = 0, $118 = 0, $119 = 0, $12 = 0, $120 = 0, $121 = 0, $122 = 0, $123 = 0, $124 = 0, $125 = 0, $126 = 0, $127 = 0, $128 = 0, $129 = 0, $13 = 0;
 var $130 = 0, $131 = 0, $132 = 0, $133 = 0, $134 = 0, $135 = 0, $136 = 0, $137 = 0, $138 = 0, $139 = 0, $14 = 0, $140 = 0, $141 = 0, $142 = 0, $143 = 0, $144 = 0, $145 = 0, $146 = 0, $147 = 0, $148 = 0;
 var $149 = 0, $15 = 0, $150 = 0, $151 = 0, $152 = 0, $153 = 0, $154 = 0, $155 = 0, $156 = 0, $157 = 0, $158 = 0, $159 = 0, $16 = 0, $160 = 0, $161 = 0, $162 = 0, $163 = 0, $164 = 0, $165 = 0, $166 = 0;
 var $167 = 0, $168 = 0, $169 = 0, $17 = 0, $170 = 0, $171 = 0, $172 = 0, $173 = 0, $174 = 0, $175 = 0, $176 = 0, $177 = 0, $178 = 0, $179 = 0, $18 = 0, $180 = 0, $181 = 0, $182 = 0, $183 = 0, $184 = 0;
 var $185 = 0, $186 = 0, $187 = 0, $188 = 0, $189 = 0, $19 = 0, $190 = 0, $191 = 0, $192 = 0, $193 = 0, $194 = 0, $195 = 0, $196 = 0, $197 = 0, $198 = 0, $199 = 0, $2 = 0, $20 = 0, $200 = 0, $201 = 0;
 var $202 = 0, $203 = 0, $204 = 0, $205 = 0, $206 = 0, $207 = 0, $208 = 0, $209 = 0, $21 = 0, $210 = 0, $211 = 0, $212 = 0, $213 = 0, $214 = 0, $215 = 0, $216 = 0, $217 = 0, $218 = 0, $219 = 0, $22 = 0;
 var $220 = 0, $221 = 0, $222 = 0, $223 = 0, $224 = 0, $225 = 0, $226 = 0, $227 = 0, $228 = 0, $229 = 0, $23 = 0, $230 = 0, $231 = 0, $232 = 0, $233 = 0, $234 = 0, $235 = 0, $236 = 0, $237 = 0, $238 = 0;
 var $239 = 0, $24 = 0, $240 = 0, $241 = 0, $242 = 0, $243 = 0, $244 = 0, $245 = 0, $246 = 0, $247 = 0, $248 = 0, $249 = 0, $25 = 0, $250 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $3 = 0, $30 = 0;
 var $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $4 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0;
 var $5 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $6 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0;
 var $68 = 0, $69 = 0, $7 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $8 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0;
 var $86 = 0, $87 = 0, $88 = 0, $89 = 0, $9 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $cond = 0, $cond4 = 0, label = 0, sp = 0;
 sp = STACKTOP;
 $2 = (($0) + ($1)|0);
 $3 = ((($0)) + 4|0);
 $4 = HEAP32[$3>>2]|0;
 $5 = $4 & 1;
 $6 = ($5|0)==(0);
 do {
  if ($6) {
   $7 = HEAP32[$0>>2]|0;
   $8 = $4 & 3;
   $9 = ($8|0)==(0);
   if ($9) {
    return;
   }
   $10 = (0 - ($7))|0;
   $11 = (($0) + ($10)|0);
   $12 = (($7) + ($1))|0;
   $13 = HEAP32[(9348)>>2]|0;
   $14 = ($13|0)==($11|0);
   if ($14) {
    $75 = ((($2)) + 4|0);
    $76 = HEAP32[$75>>2]|0;
    $77 = $76 & 3;
    $78 = ($77|0)==(3);
    if (!($78)) {
     $$1 = $11;$$1363 = $12;
     break;
    }
    $79 = ((($11)) + 4|0);
    $80 = $12 | 1;
    $81 = $76 & -2;
    HEAP32[(9336)>>2] = $12;
    HEAP32[$75>>2] = $81;
    HEAP32[$79>>2] = $80;
    HEAP32[$2>>2] = $12;
    return;
   }
   $15 = $7 >>> 3;
   $16 = ($7>>>0)<(256);
   if ($16) {
    $17 = ((($11)) + 8|0);
    $18 = HEAP32[$17>>2]|0;
    $19 = ((($11)) + 12|0);
    $20 = HEAP32[$19>>2]|0;
    $21 = ($20|0)==($18|0);
    if ($21) {
     $22 = 1 << $15;
     $23 = $22 ^ -1;
     $24 = HEAP32[2332]|0;
     $25 = $24 & $23;
     HEAP32[2332] = $25;
     $$1 = $11;$$1363 = $12;
     break;
    } else {
     $26 = ((($18)) + 12|0);
     HEAP32[$26>>2] = $20;
     $27 = ((($20)) + 8|0);
     HEAP32[$27>>2] = $18;
     $$1 = $11;$$1363 = $12;
     break;
    }
   }
   $28 = ((($11)) + 24|0);
   $29 = HEAP32[$28>>2]|0;
   $30 = ((($11)) + 12|0);
   $31 = HEAP32[$30>>2]|0;
   $32 = ($31|0)==($11|0);
   do {
    if ($32) {
     $37 = ((($11)) + 16|0);
     $38 = ((($37)) + 4|0);
     $39 = HEAP32[$38>>2]|0;
     $40 = ($39|0)==(0|0);
     if ($40) {
      $41 = HEAP32[$37>>2]|0;
      $42 = ($41|0)==(0|0);
      if ($42) {
       $$3 = 0;
       break;
      } else {
       $$1371$ph = $41;$$1374$ph = $37;
      }
     } else {
      $$1371$ph = $39;$$1374$ph = $38;
     }
     $$1371 = $$1371$ph;$$1374 = $$1374$ph;
     while(1) {
      $43 = ((($$1371)) + 20|0);
      $44 = HEAP32[$43>>2]|0;
      $45 = ($44|0)==(0|0);
      if ($45) {
       $46 = ((($$1371)) + 16|0);
       $47 = HEAP32[$46>>2]|0;
       $48 = ($47|0)==(0|0);
       if ($48) {
        break;
       } else {
        $$1371$be = $47;$$1374$be = $46;
       }
      } else {
       $$1371$be = $44;$$1374$be = $43;
      }
      $$1371 = $$1371$be;$$1374 = $$1374$be;
     }
     HEAP32[$$1374>>2] = 0;
     $$3 = $$1371;
    } else {
     $33 = ((($11)) + 8|0);
     $34 = HEAP32[$33>>2]|0;
     $35 = ((($34)) + 12|0);
     HEAP32[$35>>2] = $31;
     $36 = ((($31)) + 8|0);
     HEAP32[$36>>2] = $34;
     $$3 = $31;
    }
   } while(0);
   $49 = ($29|0)==(0|0);
   if ($49) {
    $$1 = $11;$$1363 = $12;
   } else {
    $50 = ((($11)) + 28|0);
    $51 = HEAP32[$50>>2]|0;
    $52 = (9632 + ($51<<2)|0);
    $53 = HEAP32[$52>>2]|0;
    $54 = ($53|0)==($11|0);
    if ($54) {
     HEAP32[$52>>2] = $$3;
     $cond = ($$3|0)==(0|0);
     if ($cond) {
      $55 = 1 << $51;
      $56 = $55 ^ -1;
      $57 = HEAP32[(9332)>>2]|0;
      $58 = $57 & $56;
      HEAP32[(9332)>>2] = $58;
      $$1 = $11;$$1363 = $12;
      break;
     }
    } else {
     $59 = ((($29)) + 16|0);
     $60 = HEAP32[$59>>2]|0;
     $61 = ($60|0)==($11|0);
     $62 = ((($29)) + 20|0);
     $$sink = $61 ? $59 : $62;
     HEAP32[$$sink>>2] = $$3;
     $63 = ($$3|0)==(0|0);
     if ($63) {
      $$1 = $11;$$1363 = $12;
      break;
     }
    }
    $64 = ((($$3)) + 24|0);
    HEAP32[$64>>2] = $29;
    $65 = ((($11)) + 16|0);
    $66 = HEAP32[$65>>2]|0;
    $67 = ($66|0)==(0|0);
    if (!($67)) {
     $68 = ((($$3)) + 16|0);
     HEAP32[$68>>2] = $66;
     $69 = ((($66)) + 24|0);
     HEAP32[$69>>2] = $$3;
    }
    $70 = ((($65)) + 4|0);
    $71 = HEAP32[$70>>2]|0;
    $72 = ($71|0)==(0|0);
    if ($72) {
     $$1 = $11;$$1363 = $12;
    } else {
     $73 = ((($$3)) + 20|0);
     HEAP32[$73>>2] = $71;
     $74 = ((($71)) + 24|0);
     HEAP32[$74>>2] = $$3;
     $$1 = $11;$$1363 = $12;
    }
   }
  } else {
   $$1 = $0;$$1363 = $1;
  }
 } while(0);
 $82 = ((($2)) + 4|0);
 $83 = HEAP32[$82>>2]|0;
 $84 = $83 & 2;
 $85 = ($84|0)==(0);
 if ($85) {
  $86 = HEAP32[(9352)>>2]|0;
  $87 = ($86|0)==($2|0);
  if ($87) {
   $88 = HEAP32[(9340)>>2]|0;
   $89 = (($88) + ($$1363))|0;
   HEAP32[(9340)>>2] = $89;
   HEAP32[(9352)>>2] = $$1;
   $90 = $89 | 1;
   $91 = ((($$1)) + 4|0);
   HEAP32[$91>>2] = $90;
   $92 = HEAP32[(9348)>>2]|0;
   $93 = ($$1|0)==($92|0);
   if (!($93)) {
    return;
   }
   HEAP32[(9348)>>2] = 0;
   HEAP32[(9336)>>2] = 0;
   return;
  }
  $94 = HEAP32[(9348)>>2]|0;
  $95 = ($94|0)==($2|0);
  if ($95) {
   $96 = HEAP32[(9336)>>2]|0;
   $97 = (($96) + ($$1363))|0;
   HEAP32[(9336)>>2] = $97;
   HEAP32[(9348)>>2] = $$1;
   $98 = $97 | 1;
   $99 = ((($$1)) + 4|0);
   HEAP32[$99>>2] = $98;
   $100 = (($$1) + ($97)|0);
   HEAP32[$100>>2] = $97;
   return;
  }
  $101 = $83 & -8;
  $102 = (($101) + ($$1363))|0;
  $103 = $83 >>> 3;
  $104 = ($83>>>0)<(256);
  do {
   if ($104) {
    $105 = ((($2)) + 8|0);
    $106 = HEAP32[$105>>2]|0;
    $107 = ((($2)) + 12|0);
    $108 = HEAP32[$107>>2]|0;
    $109 = ($108|0)==($106|0);
    if ($109) {
     $110 = 1 << $103;
     $111 = $110 ^ -1;
     $112 = HEAP32[2332]|0;
     $113 = $112 & $111;
     HEAP32[2332] = $113;
     break;
    } else {
     $114 = ((($106)) + 12|0);
     HEAP32[$114>>2] = $108;
     $115 = ((($108)) + 8|0);
     HEAP32[$115>>2] = $106;
     break;
    }
   } else {
    $116 = ((($2)) + 24|0);
    $117 = HEAP32[$116>>2]|0;
    $118 = ((($2)) + 12|0);
    $119 = HEAP32[$118>>2]|0;
    $120 = ($119|0)==($2|0);
    do {
     if ($120) {
      $125 = ((($2)) + 16|0);
      $126 = ((($125)) + 4|0);
      $127 = HEAP32[$126>>2]|0;
      $128 = ($127|0)==(0|0);
      if ($128) {
       $129 = HEAP32[$125>>2]|0;
       $130 = ($129|0)==(0|0);
       if ($130) {
        $$3380 = 0;
        break;
       } else {
        $$1378$ph = $129;$$1382$ph = $125;
       }
      } else {
       $$1378$ph = $127;$$1382$ph = $126;
      }
      $$1378 = $$1378$ph;$$1382 = $$1382$ph;
      while(1) {
       $131 = ((($$1378)) + 20|0);
       $132 = HEAP32[$131>>2]|0;
       $133 = ($132|0)==(0|0);
       if ($133) {
        $134 = ((($$1378)) + 16|0);
        $135 = HEAP32[$134>>2]|0;
        $136 = ($135|0)==(0|0);
        if ($136) {
         break;
        } else {
         $$1378$be = $135;$$1382$be = $134;
        }
       } else {
        $$1378$be = $132;$$1382$be = $131;
       }
       $$1378 = $$1378$be;$$1382 = $$1382$be;
      }
      HEAP32[$$1382>>2] = 0;
      $$3380 = $$1378;
     } else {
      $121 = ((($2)) + 8|0);
      $122 = HEAP32[$121>>2]|0;
      $123 = ((($122)) + 12|0);
      HEAP32[$123>>2] = $119;
      $124 = ((($119)) + 8|0);
      HEAP32[$124>>2] = $122;
      $$3380 = $119;
     }
    } while(0);
    $137 = ($117|0)==(0|0);
    if (!($137)) {
     $138 = ((($2)) + 28|0);
     $139 = HEAP32[$138>>2]|0;
     $140 = (9632 + ($139<<2)|0);
     $141 = HEAP32[$140>>2]|0;
     $142 = ($141|0)==($2|0);
     if ($142) {
      HEAP32[$140>>2] = $$3380;
      $cond4 = ($$3380|0)==(0|0);
      if ($cond4) {
       $143 = 1 << $139;
       $144 = $143 ^ -1;
       $145 = HEAP32[(9332)>>2]|0;
       $146 = $145 & $144;
       HEAP32[(9332)>>2] = $146;
       break;
      }
     } else {
      $147 = ((($117)) + 16|0);
      $148 = HEAP32[$147>>2]|0;
      $149 = ($148|0)==($2|0);
      $150 = ((($117)) + 20|0);
      $$sink24 = $149 ? $147 : $150;
      HEAP32[$$sink24>>2] = $$3380;
      $151 = ($$3380|0)==(0|0);
      if ($151) {
       break;
      }
     }
     $152 = ((($$3380)) + 24|0);
     HEAP32[$152>>2] = $117;
     $153 = ((($2)) + 16|0);
     $154 = HEAP32[$153>>2]|0;
     $155 = ($154|0)==(0|0);
     if (!($155)) {
      $156 = ((($$3380)) + 16|0);
      HEAP32[$156>>2] = $154;
      $157 = ((($154)) + 24|0);
      HEAP32[$157>>2] = $$3380;
     }
     $158 = ((($153)) + 4|0);
     $159 = HEAP32[$158>>2]|0;
     $160 = ($159|0)==(0|0);
     if (!($160)) {
      $161 = ((($$3380)) + 20|0);
      HEAP32[$161>>2] = $159;
      $162 = ((($159)) + 24|0);
      HEAP32[$162>>2] = $$3380;
     }
    }
   }
  } while(0);
  $163 = $102 | 1;
  $164 = ((($$1)) + 4|0);
  HEAP32[$164>>2] = $163;
  $165 = (($$1) + ($102)|0);
  HEAP32[$165>>2] = $102;
  $166 = HEAP32[(9348)>>2]|0;
  $167 = ($$1|0)==($166|0);
  if ($167) {
   HEAP32[(9336)>>2] = $102;
   return;
  } else {
   $$2 = $102;
  }
 } else {
  $168 = $83 & -2;
  HEAP32[$82>>2] = $168;
  $169 = $$1363 | 1;
  $170 = ((($$1)) + 4|0);
  HEAP32[$170>>2] = $169;
  $171 = (($$1) + ($$1363)|0);
  HEAP32[$171>>2] = $$1363;
  $$2 = $$1363;
 }
 $172 = $$2 >>> 3;
 $173 = ($$2>>>0)<(256);
 if ($173) {
  $174 = $172 << 1;
  $175 = (9368 + ($174<<2)|0);
  $176 = HEAP32[2332]|0;
  $177 = 1 << $172;
  $178 = $176 & $177;
  $179 = ($178|0)==(0);
  if ($179) {
   $180 = $176 | $177;
   HEAP32[2332] = $180;
   $$pre = ((($175)) + 8|0);
   $$0383 = $175;$$pre$phiZ2D = $$pre;
  } else {
   $181 = ((($175)) + 8|0);
   $182 = HEAP32[$181>>2]|0;
   $$0383 = $182;$$pre$phiZ2D = $181;
  }
  HEAP32[$$pre$phiZ2D>>2] = $$1;
  $183 = ((($$0383)) + 12|0);
  HEAP32[$183>>2] = $$1;
  $184 = ((($$1)) + 8|0);
  HEAP32[$184>>2] = $$0383;
  $185 = ((($$1)) + 12|0);
  HEAP32[$185>>2] = $175;
  return;
 }
 $186 = $$2 >>> 8;
 $187 = ($186|0)==(0);
 if ($187) {
  $$0376 = 0;
 } else {
  $188 = ($$2>>>0)>(16777215);
  if ($188) {
   $$0376 = 31;
  } else {
   $189 = (($186) + 1048320)|0;
   $190 = $189 >>> 16;
   $191 = $190 & 8;
   $192 = $186 << $191;
   $193 = (($192) + 520192)|0;
   $194 = $193 >>> 16;
   $195 = $194 & 4;
   $196 = $195 | $191;
   $197 = $192 << $195;
   $198 = (($197) + 245760)|0;
   $199 = $198 >>> 16;
   $200 = $199 & 2;
   $201 = $196 | $200;
   $202 = (14 - ($201))|0;
   $203 = $197 << $200;
   $204 = $203 >>> 15;
   $205 = (($202) + ($204))|0;
   $206 = $205 << 1;
   $207 = (($205) + 7)|0;
   $208 = $$2 >>> $207;
   $209 = $208 & 1;
   $210 = $209 | $206;
   $$0376 = $210;
  }
 }
 $211 = (9632 + ($$0376<<2)|0);
 $212 = ((($$1)) + 28|0);
 HEAP32[$212>>2] = $$0376;
 $213 = ((($$1)) + 16|0);
 $214 = ((($$1)) + 20|0);
 HEAP32[$214>>2] = 0;
 HEAP32[$213>>2] = 0;
 $215 = HEAP32[(9332)>>2]|0;
 $216 = 1 << $$0376;
 $217 = $215 & $216;
 $218 = ($217|0)==(0);
 if ($218) {
  $219 = $215 | $216;
  HEAP32[(9332)>>2] = $219;
  HEAP32[$211>>2] = $$1;
  $220 = ((($$1)) + 24|0);
  HEAP32[$220>>2] = $211;
  $221 = ((($$1)) + 12|0);
  HEAP32[$221>>2] = $$1;
  $222 = ((($$1)) + 8|0);
  HEAP32[$222>>2] = $$1;
  return;
 }
 $223 = HEAP32[$211>>2]|0;
 $224 = ((($223)) + 4|0);
 $225 = HEAP32[$224>>2]|0;
 $226 = $225 & -8;
 $227 = ($226|0)==($$2|0);
 L104: do {
  if ($227) {
   $$0365$lcssa = $223;
  } else {
   $228 = ($$0376|0)==(31);
   $229 = $$0376 >>> 1;
   $230 = (25 - ($229))|0;
   $231 = $228 ? 0 : $230;
   $232 = $$2 << $231;
   $$03649 = $232;$$03658 = $223;
   while(1) {
    $239 = $$03649 >>> 31;
    $240 = (((($$03658)) + 16|0) + ($239<<2)|0);
    $235 = HEAP32[$240>>2]|0;
    $241 = ($235|0)==(0|0);
    if ($241) {
     break;
    }
    $233 = $$03649 << 1;
    $234 = ((($235)) + 4|0);
    $236 = HEAP32[$234>>2]|0;
    $237 = $236 & -8;
    $238 = ($237|0)==($$2|0);
    if ($238) {
     $$0365$lcssa = $235;
     break L104;
    } else {
     $$03649 = $233;$$03658 = $235;
    }
   }
   HEAP32[$240>>2] = $$1;
   $242 = ((($$1)) + 24|0);
   HEAP32[$242>>2] = $$03658;
   $243 = ((($$1)) + 12|0);
   HEAP32[$243>>2] = $$1;
   $244 = ((($$1)) + 8|0);
   HEAP32[$244>>2] = $$1;
   return;
  }
 } while(0);
 $245 = ((($$0365$lcssa)) + 8|0);
 $246 = HEAP32[$245>>2]|0;
 $247 = ((($246)) + 12|0);
 HEAP32[$247>>2] = $$1;
 HEAP32[$245>>2] = $$1;
 $248 = ((($$1)) + 8|0);
 HEAP32[$248>>2] = $246;
 $249 = ((($$1)) + 12|0);
 HEAP32[$249>>2] = $$0365$lcssa;
 $250 = ((($$1)) + 24|0);
 HEAP32[$250>>2] = 0;
 return;
}
function ___muldsi3($a, $b) {
    $a = $a | 0;
    $b = $b | 0;
    var $1 = 0, $2 = 0, $3 = 0, $6 = 0, $8 = 0, $11 = 0, $12 = 0;
    $1 = $a & 65535;
    $2 = $b & 65535;
    $3 = Math_imul($2, $1) | 0;
    $6 = $a >>> 16;
    $8 = ($3 >>> 16) + (Math_imul($2, $6) | 0) | 0;
    $11 = $b >>> 16;
    $12 = Math_imul($11, $1) | 0;
    return (setTempRet0(((($8 >>> 16) + (Math_imul($11, $6) | 0) | 0) + ((($8 & 65535) + $12 | 0) >>> 16) | 0) | 0), 0 | ($8 + $12 << 16 | $3 & 65535)) | 0;
}
function ___muldi3($a$0, $a$1, $b$0, $b$1) {
    $a$0 = $a$0 | 0;
    $a$1 = $a$1 | 0;
    $b$0 = $b$0 | 0;
    $b$1 = $b$1 | 0;
    var $x_sroa_0_0_extract_trunc = 0, $y_sroa_0_0_extract_trunc = 0, $1$0 = 0, $1$1 = 0, $2 = 0;
    $x_sroa_0_0_extract_trunc = $a$0;
    $y_sroa_0_0_extract_trunc = $b$0;
    $1$0 = ___muldsi3($x_sroa_0_0_extract_trunc, $y_sroa_0_0_extract_trunc) | 0;
    $1$1 = (getTempRet0() | 0);
    $2 = Math_imul($a$1, $y_sroa_0_0_extract_trunc) | 0;
    return (setTempRet0((((Math_imul($b$1, $x_sroa_0_0_extract_trunc) | 0) + $2 | 0) + $1$1 | $1$1 & 0) | 0), 0 | $1$0 & -1) | 0;
}
function _i64Add(a, b, c, d) {
    /*
      x = a + b*2^32
      y = c + d*2^32
      result = l + h*2^32
    */
    a = a|0; b = b|0; c = c|0; d = d|0;
    var l = 0, h = 0;
    l = (a + c)>>>0;
    h = (b + d + (((l>>>0) < (a>>>0))|0))>>>0; // Add carry from low word to high word on overflow.
    return ((setTempRet0((h) | 0),l|0)|0);
}
function _i64Subtract(a, b, c, d) {
    a = a|0; b = b|0; c = c|0; d = d|0;
    var l = 0, h = 0;
    l = (a - c)>>>0;
    h = (b - d)>>>0;
    h = (b - d - (((c>>>0) > (a>>>0))|0))>>>0; // Borrow one from high word to low word on underflow.
    return ((setTempRet0((h) | 0),l|0)|0);
}
function _llvm_cttz_i32(x) { // Note: Currently doesn't take isZeroUndef()
    x = x | 0;
    return (x ? (31 - (Math_clz32((x ^ (x - 1))) | 0) | 0) : 32) | 0;
}
function ___udivmoddi4($a$0, $a$1, $b$0, $b$1, $rem) {
    $a$0 = $a$0 | 0;
    $a$1 = $a$1 | 0;
    $b$0 = $b$0 | 0;
    $b$1 = $b$1 | 0;
    $rem = $rem | 0;
    var $n_sroa_0_0_extract_trunc = 0, $n_sroa_1_4_extract_shift$0 = 0, $n_sroa_1_4_extract_trunc = 0, $d_sroa_0_0_extract_trunc = 0, $d_sroa_1_4_extract_shift$0 = 0, $d_sroa_1_4_extract_trunc = 0, $4 = 0, $17 = 0, $37 = 0, $49 = 0, $51 = 0, $57 = 0, $58 = 0, $66 = 0, $78 = 0, $86 = 0, $88 = 0, $89 = 0, $91 = 0, $92 = 0, $95 = 0, $105 = 0, $117 = 0, $119 = 0, $125 = 0, $126 = 0, $130 = 0, $q_sroa_1_1_ph = 0, $q_sroa_0_1_ph = 0, $r_sroa_1_1_ph = 0, $r_sroa_0_1_ph = 0, $sr_1_ph = 0, $d_sroa_0_0_insert_insert99$0 = 0, $d_sroa_0_0_insert_insert99$1 = 0, $137$0 = 0, $137$1 = 0, $carry_0203 = 0, $sr_1202 = 0, $r_sroa_0_1201 = 0, $r_sroa_1_1200 = 0, $q_sroa_0_1199 = 0, $q_sroa_1_1198 = 0, $147 = 0, $149 = 0, $r_sroa_0_0_insert_insert42$0 = 0, $r_sroa_0_0_insert_insert42$1 = 0, $150$1 = 0, $151$0 = 0, $152 = 0, $154$0 = 0, $r_sroa_0_0_extract_trunc = 0, $r_sroa_1_4_extract_trunc = 0, $155 = 0, $carry_0_lcssa$0 = 0, $carry_0_lcssa$1 = 0, $r_sroa_0_1_lcssa = 0, $r_sroa_1_1_lcssa = 0, $q_sroa_0_1_lcssa = 0, $q_sroa_1_1_lcssa = 0, $q_sroa_0_0_insert_ext75$0 = 0, $q_sroa_0_0_insert_ext75$1 = 0, $q_sroa_0_0_insert_insert77$1 = 0, $_0$0 = 0, $_0$1 = 0;
    $n_sroa_0_0_extract_trunc = $a$0;
    $n_sroa_1_4_extract_shift$0 = $a$1;
    $n_sroa_1_4_extract_trunc = $n_sroa_1_4_extract_shift$0;
    $d_sroa_0_0_extract_trunc = $b$0;
    $d_sroa_1_4_extract_shift$0 = $b$1;
    $d_sroa_1_4_extract_trunc = $d_sroa_1_4_extract_shift$0;
    if (($n_sroa_1_4_extract_trunc | 0) == 0) {
      $4 = ($rem | 0) != 0;
      if (($d_sroa_1_4_extract_trunc | 0) == 0) {
        if ($4) {
          HEAP32[$rem >> 2] = ($n_sroa_0_0_extract_trunc >>> 0) % ($d_sroa_0_0_extract_trunc >>> 0);
          HEAP32[$rem + 4 >> 2] = 0;
        }
        $_0$1 = 0;
        $_0$0 = ($n_sroa_0_0_extract_trunc >>> 0) / ($d_sroa_0_0_extract_trunc >>> 0) >>> 0;
        return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
      } else {
        if (!$4) {
          $_0$1 = 0;
          $_0$0 = 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        HEAP32[$rem >> 2] = $a$0 & -1;
        HEAP32[$rem + 4 >> 2] = $a$1 & 0;
        $_0$1 = 0;
        $_0$0 = 0;
        return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
      }
    }
    $17 = ($d_sroa_1_4_extract_trunc | 0) == 0;
    do {
      if (($d_sroa_0_0_extract_trunc | 0) == 0) {
        if ($17) {
          if (($rem | 0) != 0) {
            HEAP32[$rem >> 2] = ($n_sroa_1_4_extract_trunc >>> 0) % ($d_sroa_0_0_extract_trunc >>> 0);
            HEAP32[$rem + 4 >> 2] = 0;
          }
          $_0$1 = 0;
          $_0$0 = ($n_sroa_1_4_extract_trunc >>> 0) / ($d_sroa_0_0_extract_trunc >>> 0) >>> 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        if (($n_sroa_0_0_extract_trunc | 0) == 0) {
          if (($rem | 0) != 0) {
            HEAP32[$rem >> 2] = 0;
            HEAP32[$rem + 4 >> 2] = ($n_sroa_1_4_extract_trunc >>> 0) % ($d_sroa_1_4_extract_trunc >>> 0);
          }
          $_0$1 = 0;
          $_0$0 = ($n_sroa_1_4_extract_trunc >>> 0) / ($d_sroa_1_4_extract_trunc >>> 0) >>> 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        $37 = $d_sroa_1_4_extract_trunc - 1 | 0;
        if (($37 & $d_sroa_1_4_extract_trunc | 0) == 0) {
          if (($rem | 0) != 0) {
            HEAP32[$rem >> 2] = 0 | $a$0 & -1;
            HEAP32[$rem + 4 >> 2] = $37 & $n_sroa_1_4_extract_trunc | $a$1 & 0;
          }
          $_0$1 = 0;
          $_0$0 = $n_sroa_1_4_extract_trunc >>> ((_llvm_cttz_i32($d_sroa_1_4_extract_trunc | 0) | 0) >>> 0);
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        $49 = Math_clz32($d_sroa_1_4_extract_trunc | 0) | 0;
        $51 = $49 - (Math_clz32($n_sroa_1_4_extract_trunc | 0) | 0) | 0;
        if ($51 >>> 0 <= 30) {
          $57 = $51 + 1 | 0;
          $58 = 31 - $51 | 0;
          $sr_1_ph = $57;
          $r_sroa_0_1_ph = $n_sroa_1_4_extract_trunc << $58 | $n_sroa_0_0_extract_trunc >>> ($57 >>> 0);
          $r_sroa_1_1_ph = $n_sroa_1_4_extract_trunc >>> ($57 >>> 0);
          $q_sroa_0_1_ph = 0;
          $q_sroa_1_1_ph = $n_sroa_0_0_extract_trunc << $58;
          break;
        }
        if (($rem | 0) == 0) {
          $_0$1 = 0;
          $_0$0 = 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        HEAP32[$rem >> 2] = 0 | $a$0 & -1;
        HEAP32[$rem + 4 >> 2] = $n_sroa_1_4_extract_shift$0 | $a$1 & 0;
        $_0$1 = 0;
        $_0$0 = 0;
        return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
      } else {
        if (!$17) {
          $117 = Math_clz32($d_sroa_1_4_extract_trunc | 0) | 0;
          $119 = $117 - (Math_clz32($n_sroa_1_4_extract_trunc | 0) | 0) | 0;
          if ($119 >>> 0 <= 31) {
            $125 = $119 + 1 | 0;
            $126 = 31 - $119 | 0;
            $130 = $119 - 31 >> 31;
            $sr_1_ph = $125;
            $r_sroa_0_1_ph = $n_sroa_0_0_extract_trunc >>> ($125 >>> 0) & $130 | $n_sroa_1_4_extract_trunc << $126;
            $r_sroa_1_1_ph = $n_sroa_1_4_extract_trunc >>> ($125 >>> 0) & $130;
            $q_sroa_0_1_ph = 0;
            $q_sroa_1_1_ph = $n_sroa_0_0_extract_trunc << $126;
            break;
          }
          if (($rem | 0) == 0) {
            $_0$1 = 0;
            $_0$0 = 0;
            return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
          }
          HEAP32[$rem >> 2] = 0 | $a$0 & -1;
          HEAP32[$rem + 4 >> 2] = $n_sroa_1_4_extract_shift$0 | $a$1 & 0;
          $_0$1 = 0;
          $_0$0 = 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
        $66 = $d_sroa_0_0_extract_trunc - 1 | 0;
        if (($66 & $d_sroa_0_0_extract_trunc | 0) != 0) {
          $86 = (Math_clz32($d_sroa_0_0_extract_trunc | 0) | 0) + 33 | 0;
          $88 = $86 - (Math_clz32($n_sroa_1_4_extract_trunc | 0) | 0) | 0;
          $89 = 64 - $88 | 0;
          $91 = 32 - $88 | 0;
          $92 = $91 >> 31;
          $95 = $88 - 32 | 0;
          $105 = $95 >> 31;
          $sr_1_ph = $88;
          $r_sroa_0_1_ph = $91 - 1 >> 31 & $n_sroa_1_4_extract_trunc >>> ($95 >>> 0) | ($n_sroa_1_4_extract_trunc << $91 | $n_sroa_0_0_extract_trunc >>> ($88 >>> 0)) & $105;
          $r_sroa_1_1_ph = $105 & $n_sroa_1_4_extract_trunc >>> ($88 >>> 0);
          $q_sroa_0_1_ph = $n_sroa_0_0_extract_trunc << $89 & $92;
          $q_sroa_1_1_ph = ($n_sroa_1_4_extract_trunc << $89 | $n_sroa_0_0_extract_trunc >>> ($95 >>> 0)) & $92 | $n_sroa_0_0_extract_trunc << $91 & $88 - 33 >> 31;
          break;
        }
        if (($rem | 0) != 0) {
          HEAP32[$rem >> 2] = $66 & $n_sroa_0_0_extract_trunc;
          HEAP32[$rem + 4 >> 2] = 0;
        }
        if (($d_sroa_0_0_extract_trunc | 0) == 1) {
          $_0$1 = $n_sroa_1_4_extract_shift$0 | $a$1 & 0;
          $_0$0 = 0 | $a$0 & -1;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        } else {
          $78 = _llvm_cttz_i32($d_sroa_0_0_extract_trunc | 0) | 0;
          $_0$1 = 0 | $n_sroa_1_4_extract_trunc >>> ($78 >>> 0);
          $_0$0 = $n_sroa_1_4_extract_trunc << 32 - $78 | $n_sroa_0_0_extract_trunc >>> ($78 >>> 0) | 0;
          return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
        }
      }
    } while (0);
    if (($sr_1_ph | 0) == 0) {
      $q_sroa_1_1_lcssa = $q_sroa_1_1_ph;
      $q_sroa_0_1_lcssa = $q_sroa_0_1_ph;
      $r_sroa_1_1_lcssa = $r_sroa_1_1_ph;
      $r_sroa_0_1_lcssa = $r_sroa_0_1_ph;
      $carry_0_lcssa$1 = 0;
      $carry_0_lcssa$0 = 0;
    } else {
      $d_sroa_0_0_insert_insert99$0 = 0 | $b$0 & -1;
      $d_sroa_0_0_insert_insert99$1 = $d_sroa_1_4_extract_shift$0 | $b$1 & 0;
      $137$0 = _i64Add($d_sroa_0_0_insert_insert99$0 | 0, $d_sroa_0_0_insert_insert99$1 | 0, -1, -1) | 0;
      $137$1 = (getTempRet0() | 0);
      $q_sroa_1_1198 = $q_sroa_1_1_ph;
      $q_sroa_0_1199 = $q_sroa_0_1_ph;
      $r_sroa_1_1200 = $r_sroa_1_1_ph;
      $r_sroa_0_1201 = $r_sroa_0_1_ph;
      $sr_1202 = $sr_1_ph;
      $carry_0203 = 0;
      while (1) {
        $147 = $q_sroa_0_1199 >>> 31 | $q_sroa_1_1198 << 1;
        $149 = $carry_0203 | $q_sroa_0_1199 << 1;
        $r_sroa_0_0_insert_insert42$0 = 0 | ($r_sroa_0_1201 << 1 | $q_sroa_1_1198 >>> 31);
        $r_sroa_0_0_insert_insert42$1 = $r_sroa_0_1201 >>> 31 | $r_sroa_1_1200 << 1 | 0;
        _i64Subtract($137$0 | 0, $137$1 | 0, $r_sroa_0_0_insert_insert42$0 | 0, $r_sroa_0_0_insert_insert42$1 | 0) | 0;
        $150$1 = (getTempRet0() | 0);
        $151$0 = $150$1 >> 31 | (($150$1 | 0) < 0 ? -1 : 0) << 1;
        $152 = $151$0 & 1;
        $154$0 = _i64Subtract($r_sroa_0_0_insert_insert42$0 | 0, $r_sroa_0_0_insert_insert42$1 | 0, $151$0 & $d_sroa_0_0_insert_insert99$0 | 0, ((($150$1 | 0) < 0 ? -1 : 0) >> 31 | (($150$1 | 0) < 0 ? -1 : 0) << 1) & $d_sroa_0_0_insert_insert99$1 | 0) | 0;
        $r_sroa_0_0_extract_trunc = $154$0;
        $r_sroa_1_4_extract_trunc = (getTempRet0() | 0);
        $155 = $sr_1202 - 1 | 0;
        if (($155 | 0) == 0) {
          break;
        } else {
          $q_sroa_1_1198 = $147;
          $q_sroa_0_1199 = $149;
          $r_sroa_1_1200 = $r_sroa_1_4_extract_trunc;
          $r_sroa_0_1201 = $r_sroa_0_0_extract_trunc;
          $sr_1202 = $155;
          $carry_0203 = $152;
        }
      }
      $q_sroa_1_1_lcssa = $147;
      $q_sroa_0_1_lcssa = $149;
      $r_sroa_1_1_lcssa = $r_sroa_1_4_extract_trunc;
      $r_sroa_0_1_lcssa = $r_sroa_0_0_extract_trunc;
      $carry_0_lcssa$1 = 0;
      $carry_0_lcssa$0 = $152;
    }
    $q_sroa_0_0_insert_ext75$0 = $q_sroa_0_1_lcssa;
    $q_sroa_0_0_insert_ext75$1 = 0;
    $q_sroa_0_0_insert_insert77$1 = $q_sroa_1_1_lcssa | $q_sroa_0_0_insert_ext75$1;
    if (($rem | 0) != 0) {
      HEAP32[$rem >> 2] = 0 | $r_sroa_0_1_lcssa;
      HEAP32[$rem + 4 >> 2] = $r_sroa_1_1_lcssa | 0;
    }
    $_0$1 = (0 | $q_sroa_0_0_insert_ext75$0) >>> 31 | $q_sroa_0_0_insert_insert77$1 << 1 | ($q_sroa_0_0_insert_ext75$1 << 1 | $q_sroa_0_0_insert_ext75$0 >>> 31) & 0 | $carry_0_lcssa$1;
    $_0$0 = ($q_sroa_0_0_insert_ext75$0 << 1 | 0 >>> 31) & -2 | $carry_0_lcssa$0;
    return (setTempRet0(($_0$1) | 0), $_0$0) | 0;
}
function ___udivdi3($a$0, $a$1, $b$0, $b$1) {
    $a$0 = $a$0 | 0;
    $a$1 = $a$1 | 0;
    $b$0 = $b$0 | 0;
    $b$1 = $b$1 | 0;
    var $1$0 = 0;
    $1$0 = ___udivmoddi4($a$0, $a$1, $b$0, $b$1, 0) | 0;
    return $1$0 | 0;
}
function _bitshift64Lshr(low, high, bits) {
    low = low|0; high = high|0; bits = bits|0;
    var ander = 0;
    if ((bits|0) < 32) {
      ander = ((1 << bits) - 1)|0;
      setTempRet0((high >>> bits) | 0);
      return (low >>> bits) | ((high&ander) << (32 - bits));
    }
    setTempRet0((0) | 0);
    return (high >>> (bits - 32))|0;
}
function _bitshift64Shl(low, high, bits) {
    low = low|0; high = high|0; bits = bits|0;
    var ander = 0;
    if ((bits|0) < 32) {
      ander = ((1 << bits) - 1)|0;
      setTempRet0(((high << bits) | ((low&(ander << (32 - bits))) >>> (32 - bits))) | 0);
      return low << bits;
    }
    setTempRet0((low << (bits - 32)) | 0);
    return 0;
}
function _llvm_bswap_i32(x) {
    x = x|0;
    return (((x&0xff)<<24) | (((x>>8)&0xff)<<16) | (((x>>16)&0xff)<<8) | (x>>>24))|0;
}
function _memcpy(dest, src, num) {
    dest = dest|0; src = src|0; num = num|0;
    var ret = 0;
    var aligned_dest_end = 0;
    var block_aligned_dest_end = 0;
    var dest_end = 0;
    // Test against a benchmarked cutoff limit for when HEAPU8.set() becomes faster to use.
    if ((num|0) >= 8192) {
      _emscripten_memcpy_big(dest|0, src|0, num|0)|0;
      return dest|0;
    }

    ret = dest|0;
    dest_end = (dest + num)|0;
    if ((dest&3) == (src&3)) {
      // The initial unaligned < 4-byte front.
      while (dest & 3) {
        if ((num|0) == 0) return ret|0;
        HEAP8[((dest)>>0)]=((HEAP8[((src)>>0)])|0);
        dest = (dest+1)|0;
        src = (src+1)|0;
        num = (num-1)|0;
      }
      aligned_dest_end = (dest_end & -4)|0;
      block_aligned_dest_end = (aligned_dest_end - 64)|0;
      while ((dest|0) <= (block_aligned_dest_end|0) ) {
        HEAP32[((dest)>>2)]=((HEAP32[((src)>>2)])|0);
        HEAP32[(((dest)+(4))>>2)]=((HEAP32[(((src)+(4))>>2)])|0);
        HEAP32[(((dest)+(8))>>2)]=((HEAP32[(((src)+(8))>>2)])|0);
        HEAP32[(((dest)+(12))>>2)]=((HEAP32[(((src)+(12))>>2)])|0);
        HEAP32[(((dest)+(16))>>2)]=((HEAP32[(((src)+(16))>>2)])|0);
        HEAP32[(((dest)+(20))>>2)]=((HEAP32[(((src)+(20))>>2)])|0);
        HEAP32[(((dest)+(24))>>2)]=((HEAP32[(((src)+(24))>>2)])|0);
        HEAP32[(((dest)+(28))>>2)]=((HEAP32[(((src)+(28))>>2)])|0);
        HEAP32[(((dest)+(32))>>2)]=((HEAP32[(((src)+(32))>>2)])|0);
        HEAP32[(((dest)+(36))>>2)]=((HEAP32[(((src)+(36))>>2)])|0);
        HEAP32[(((dest)+(40))>>2)]=((HEAP32[(((src)+(40))>>2)])|0);
        HEAP32[(((dest)+(44))>>2)]=((HEAP32[(((src)+(44))>>2)])|0);
        HEAP32[(((dest)+(48))>>2)]=((HEAP32[(((src)+(48))>>2)])|0);
        HEAP32[(((dest)+(52))>>2)]=((HEAP32[(((src)+(52))>>2)])|0);
        HEAP32[(((dest)+(56))>>2)]=((HEAP32[(((src)+(56))>>2)])|0);
        HEAP32[(((dest)+(60))>>2)]=((HEAP32[(((src)+(60))>>2)])|0);
        dest = (dest+64)|0;
        src = (src+64)|0;
      }
      while ((dest|0) < (aligned_dest_end|0) ) {
        HEAP32[((dest)>>2)]=((HEAP32[((src)>>2)])|0);
        dest = (dest+4)|0;
        src = (src+4)|0;
      }
    } else {
      // In the unaligned copy case, unroll a bit as well.
      aligned_dest_end = (dest_end - 4)|0;
      while ((dest|0) < (aligned_dest_end|0) ) {
        HEAP8[((dest)>>0)]=((HEAP8[((src)>>0)])|0);
        HEAP8[(((dest)+(1))>>0)]=((HEAP8[(((src)+(1))>>0)])|0);
        HEAP8[(((dest)+(2))>>0)]=((HEAP8[(((src)+(2))>>0)])|0);
        HEAP8[(((dest)+(3))>>0)]=((HEAP8[(((src)+(3))>>0)])|0);
        dest = (dest+4)|0;
        src = (src+4)|0;
      }
    }
    // The remaining unaligned < 4 byte tail.
    while ((dest|0) < (dest_end|0)) {
      HEAP8[((dest)>>0)]=((HEAP8[((src)>>0)])|0);
      dest = (dest+1)|0;
      src = (src+1)|0;
    }
    return ret|0;
}
function _memset(ptr, value, num) {
    ptr = ptr|0; value = value|0; num = num|0;
    var end = 0, aligned_end = 0, block_aligned_end = 0, value4 = 0;
    end = (ptr + num)|0;

    value = value & 0xff;
    if ((num|0) >= 67 /* 64 bytes for an unrolled loop + 3 bytes for unaligned head*/) {
      while ((ptr&3) != 0) {
        HEAP8[((ptr)>>0)]=value;
        ptr = (ptr+1)|0;
      }

      aligned_end = (end & -4)|0;
      value4 = value | (value << 8) | (value << 16) | (value << 24);

      block_aligned_end = (aligned_end - 64)|0;

      while((ptr|0) <= (block_aligned_end|0)) {
        HEAP32[((ptr)>>2)]=value4;
        HEAP32[(((ptr)+(4))>>2)]=value4;
        HEAP32[(((ptr)+(8))>>2)]=value4;
        HEAP32[(((ptr)+(12))>>2)]=value4;
        HEAP32[(((ptr)+(16))>>2)]=value4;
        HEAP32[(((ptr)+(20))>>2)]=value4;
        HEAP32[(((ptr)+(24))>>2)]=value4;
        HEAP32[(((ptr)+(28))>>2)]=value4;
        HEAP32[(((ptr)+(32))>>2)]=value4;
        HEAP32[(((ptr)+(36))>>2)]=value4;
        HEAP32[(((ptr)+(40))>>2)]=value4;
        HEAP32[(((ptr)+(44))>>2)]=value4;
        HEAP32[(((ptr)+(48))>>2)]=value4;
        HEAP32[(((ptr)+(52))>>2)]=value4;
        HEAP32[(((ptr)+(56))>>2)]=value4;
        HEAP32[(((ptr)+(60))>>2)]=value4;
        ptr = (ptr + 64)|0;
      }

      while ((ptr|0) < (aligned_end|0) ) {
        HEAP32[((ptr)>>2)]=value4;
        ptr = (ptr+4)|0;
      }
    }
    // The remaining bytes.
    while ((ptr|0) < (end|0)) {
      HEAP8[((ptr)>>0)]=value;
      ptr = (ptr+1)|0;
    }
    return (end-num)|0;
}
function _sbrk(increment) {
    increment = increment|0;
    var oldDynamicTop = 0;
    var oldDynamicTopOnChange = 0;
    var newDynamicTop = 0;
    var totalMemory = 0;
    totalMemory = _emscripten_get_heap_size()|0;

      oldDynamicTop = HEAP32[DYNAMICTOP_PTR>>2]|0;
      newDynamicTop = oldDynamicTop + increment | 0;

      if (((increment|0) > 0 & (newDynamicTop|0) < (oldDynamicTop|0)) // Detect and fail if we would wrap around signed 32-bit int.
        | (newDynamicTop|0) < 0) { // Also underflow, sbrk() should be able to be used to subtract.
        abortOnCannotGrowMemory(newDynamicTop|0)|0;
        ___setErrNo(12);
        return -1;
      }

      if ((newDynamicTop|0) > (totalMemory|0)) {
        if (_emscripten_resize_heap(newDynamicTop|0)|0) {
          // We resized the heap. Start another loop iteration if we need to.
        } else {
          // We failed to resize the heap.
          ___setErrNo(12);
          return -1;
        }
      }

      HEAP32[DYNAMICTOP_PTR>>2] = newDynamicTop|0;

    return oldDynamicTop|0;
}

  
function dynCall_ii(index,a1) {
  index = index|0;
  a1=a1|0;
  return FUNCTION_TABLE_ii[index&7](a1|0)|0;
}


function dynCall_iidiiii(index,a1,a2,a3,a4,a5,a6) {
  index = index|0;
  a1=a1|0; a2=+a2; a3=a3|0; a4=a4|0; a5=a5|0; a6=a6|0;
  return FUNCTION_TABLE_iidiiii[index&7](a1|0,+a2,a3|0,a4|0,a5|0,a6|0)|0;
}


function dynCall_iiii(index,a1,a2,a3) {
  index = index|0;
  a1=a1|0; a2=a2|0; a3=a3|0;
  return FUNCTION_TABLE_iiii[index&3](a1|0,a2|0,a3|0)|0;
}


function dynCall_iiiii(index,a1,a2,a3,a4) {
  index = index|0;
  a1=a1|0; a2=a2|0; a3=a3|0; a4=a4|0;
  return FUNCTION_TABLE_iiiii[index&7](a1|0,a2|0,a3|0,a4|0)|0;
}


function dynCall_vii(index,a1,a2) {
  index = index|0;
  a1=a1|0; a2=a2|0;
  FUNCTION_TABLE_vii[index&7](a1|0,a2|0);
}

function b0(p0) {
 p0 = p0|0; nullFunc_ii(0);return 0;
}
function b1(p0,p1,p2,p3,p4,p5) {
 p0 = p0|0;p1 = +p1;p2 = p2|0;p3 = p3|0;p4 = p4|0;p5 = p5|0; nullFunc_iidiiii(1);return 0;
}
function b2(p0,p1,p2) {
 p0 = p0|0;p1 = p1|0;p2 = p2|0; nullFunc_iiii(2);return 0;
}
function b3(p0,p1,p2,p3) {
 p0 = p0|0;p1 = p1|0;p2 = p2|0;p3 = p3|0; nullFunc_iiiii(3);return 0;
}
function b4(p0,p1) {
 p0 = p0|0;p1 = p1|0; nullFunc_vii(4);
}

// EMSCRIPTEN_END_FUNCS
var FUNCTION_TABLE_ii = [b0,___stdio_close,b0,b0,___emscripten_stdout_close,b0,b0,b0];
var FUNCTION_TABLE_iidiiii = [b1,b1,b1,b1,b1,b1,_fmt_fp,b1];
var FUNCTION_TABLE_iiii = [b2,b2,___stdio_write,b2];
var FUNCTION_TABLE_iiiii = [b3,b3,b3,___stdio_seek,b3,___emscripten_stdout_seek,b3,b3];
var FUNCTION_TABLE_vii = [b4,b4,b4,b4,b4,b4,b4,_pop_arg_long_double];

  return { ___errno_location: ___errno_location, ___muldi3: ___muldi3, ___udivdi3: ___udivdi3, _bitshift64Lshr: _bitshift64Lshr, _bitshift64Shl: _bitshift64Shl, _fflush: _fflush, _free: _free, _i64Add: _i64Add, _i64Subtract: _i64Subtract, _llvm_bswap_i32: _llvm_bswap_i32, _llvm_cttz_i32: _llvm_cttz_i32, _main: _main, _malloc: _malloc, _memcpy: _memcpy, _memset: _memset, _sbrk: _sbrk, dynCall_ii: dynCall_ii, dynCall_iidiiii: dynCall_iidiiii, dynCall_iiii: dynCall_iiii, dynCall_iiiii: dynCall_iiiii, dynCall_vii: dynCall_vii, establishStackSpace: establishStackSpace, stackAlloc: stackAlloc, stackRestore: stackRestore, stackSave: stackSave };
})
// EMSCRIPTEN_END_ASM
(asmGlobalArg, asmLibraryArg, buffer);

var real____errno_location = asm["___errno_location"];
asm["___errno_location"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real____errno_location.apply(null, arguments);
};

var real____muldi3 = asm["___muldi3"];
asm["___muldi3"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real____muldi3.apply(null, arguments);
};

var real____udivdi3 = asm["___udivdi3"];
asm["___udivdi3"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real____udivdi3.apply(null, arguments);
};

var real__bitshift64Lshr = asm["_bitshift64Lshr"];
asm["_bitshift64Lshr"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__bitshift64Lshr.apply(null, arguments);
};

var real__bitshift64Shl = asm["_bitshift64Shl"];
asm["_bitshift64Shl"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__bitshift64Shl.apply(null, arguments);
};

var real__fflush = asm["_fflush"];
asm["_fflush"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__fflush.apply(null, arguments);
};

var real__free = asm["_free"];
asm["_free"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__free.apply(null, arguments);
};

var real__i64Add = asm["_i64Add"];
asm["_i64Add"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__i64Add.apply(null, arguments);
};

var real__i64Subtract = asm["_i64Subtract"];
asm["_i64Subtract"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__i64Subtract.apply(null, arguments);
};

var real__llvm_bswap_i32 = asm["_llvm_bswap_i32"];
asm["_llvm_bswap_i32"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__llvm_bswap_i32.apply(null, arguments);
};

var real__llvm_cttz_i32 = asm["_llvm_cttz_i32"];
asm["_llvm_cttz_i32"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__llvm_cttz_i32.apply(null, arguments);
};

var real__main = asm["_main"];
asm["_main"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__main.apply(null, arguments);
};

var real__malloc = asm["_malloc"];
asm["_malloc"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__malloc.apply(null, arguments);
};

var real__sbrk = asm["_sbrk"];
asm["_sbrk"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real__sbrk.apply(null, arguments);
};

var real_establishStackSpace = asm["establishStackSpace"];
asm["establishStackSpace"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_establishStackSpace.apply(null, arguments);
};

var real_stackAlloc = asm["stackAlloc"];
asm["stackAlloc"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_stackAlloc.apply(null, arguments);
};

var real_stackRestore = asm["stackRestore"];
asm["stackRestore"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_stackRestore.apply(null, arguments);
};

var real_stackSave = asm["stackSave"];
asm["stackSave"] = function() {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)');
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
  return real_stackSave.apply(null, arguments);
};
var ___errno_location = Module["___errno_location"] = asm["___errno_location"];
var ___muldi3 = Module["___muldi3"] = asm["___muldi3"];
var ___udivdi3 = Module["___udivdi3"] = asm["___udivdi3"];
var _bitshift64Lshr = Module["_bitshift64Lshr"] = asm["_bitshift64Lshr"];
var _bitshift64Shl = Module["_bitshift64Shl"] = asm["_bitshift64Shl"];
var _fflush = Module["_fflush"] = asm["_fflush"];
var _free = Module["_free"] = asm["_free"];
var _i64Add = Module["_i64Add"] = asm["_i64Add"];
var _i64Subtract = Module["_i64Subtract"] = asm["_i64Subtract"];
var _llvm_bswap_i32 = Module["_llvm_bswap_i32"] = asm["_llvm_bswap_i32"];
var _llvm_cttz_i32 = Module["_llvm_cttz_i32"] = asm["_llvm_cttz_i32"];
var _main = Module["_main"] = asm["_main"];
var _malloc = Module["_malloc"] = asm["_malloc"];
var _memcpy = Module["_memcpy"] = asm["_memcpy"];
var _memset = Module["_memset"] = asm["_memset"];
var _sbrk = Module["_sbrk"] = asm["_sbrk"];
var establishStackSpace = Module["establishStackSpace"] = asm["establishStackSpace"];
var stackAlloc = Module["stackAlloc"] = asm["stackAlloc"];
var stackRestore = Module["stackRestore"] = asm["stackRestore"];
var stackSave = Module["stackSave"] = asm["stackSave"];
var dynCall_ii = Module["dynCall_ii"] = asm["dynCall_ii"];
var dynCall_iidiiii = Module["dynCall_iidiiii"] = asm["dynCall_iidiiii"];
var dynCall_iiii = Module["dynCall_iiii"] = asm["dynCall_iiii"];
var dynCall_iiiii = Module["dynCall_iiiii"] = asm["dynCall_iiiii"];
var dynCall_vii = Module["dynCall_vii"] = asm["dynCall_vii"];
;



// === Auto-generated postamble setup entry stuff ===

Module['asm'] = asm;

if (!Object.getOwnPropertyDescriptor(Module, "intArrayFromString")) Module["intArrayFromString"] = function() { abort("'intArrayFromString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "intArrayToString")) Module["intArrayToString"] = function() { abort("'intArrayToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "ccall")) Module["ccall"] = function() { abort("'ccall' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "cwrap")) Module["cwrap"] = function() { abort("'cwrap' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setValue")) Module["setValue"] = function() { abort("'setValue' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getValue")) Module["getValue"] = function() { abort("'getValue' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "allocate")) Module["allocate"] = function() { abort("'allocate' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getMemory")) Module["getMemory"] = function() { abort("'getMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "AsciiToString")) Module["AsciiToString"] = function() { abort("'AsciiToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToAscii")) Module["stringToAscii"] = function() { abort("'stringToAscii' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF8ArrayToString")) Module["UTF8ArrayToString"] = function() { abort("'UTF8ArrayToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF8ToString")) Module["UTF8ToString"] = function() { abort("'UTF8ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF8Array")) Module["stringToUTF8Array"] = function() { abort("'stringToUTF8Array' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF8")) Module["stringToUTF8"] = function() { abort("'stringToUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "lengthBytesUTF8")) Module["lengthBytesUTF8"] = function() { abort("'lengthBytesUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF16ToString")) Module["UTF16ToString"] = function() { abort("'UTF16ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF16")) Module["stringToUTF16"] = function() { abort("'stringToUTF16' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "lengthBytesUTF16")) Module["lengthBytesUTF16"] = function() { abort("'lengthBytesUTF16' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF32ToString")) Module["UTF32ToString"] = function() { abort("'UTF32ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF32")) Module["stringToUTF32"] = function() { abort("'stringToUTF32' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "lengthBytesUTF32")) Module["lengthBytesUTF32"] = function() { abort("'lengthBytesUTF32' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "allocateUTF8")) Module["allocateUTF8"] = function() { abort("'allocateUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackTrace")) Module["stackTrace"] = function() { abort("'stackTrace' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnPreRun")) Module["addOnPreRun"] = function() { abort("'addOnPreRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnInit")) Module["addOnInit"] = function() { abort("'addOnInit' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnPreMain")) Module["addOnPreMain"] = function() { abort("'addOnPreMain' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnExit")) Module["addOnExit"] = function() { abort("'addOnExit' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnPostRun")) Module["addOnPostRun"] = function() { abort("'addOnPostRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeStringToMemory")) Module["writeStringToMemory"] = function() { abort("'writeStringToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeArrayToMemory")) Module["writeArrayToMemory"] = function() { abort("'writeArrayToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeAsciiToMemory")) Module["writeAsciiToMemory"] = function() { abort("'writeAsciiToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addRunDependency")) Module["addRunDependency"] = function() { abort("'addRunDependency' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "removeRunDependency")) Module["removeRunDependency"] = function() { abort("'removeRunDependency' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "ENV")) Module["ENV"] = function() { abort("'ENV' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "FS")) Module["FS"] = function() { abort("'FS' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createFolder")) Module["FS_createFolder"] = function() { abort("'FS_createFolder' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createPath")) Module["FS_createPath"] = function() { abort("'FS_createPath' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createDataFile")) Module["FS_createDataFile"] = function() { abort("'FS_createDataFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createPreloadedFile")) Module["FS_createPreloadedFile"] = function() { abort("'FS_createPreloadedFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createLazyFile")) Module["FS_createLazyFile"] = function() { abort("'FS_createLazyFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createLink")) Module["FS_createLink"] = function() { abort("'FS_createLink' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createDevice")) Module["FS_createDevice"] = function() { abort("'FS_createDevice' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_unlink")) Module["FS_unlink"] = function() { abort("'FS_unlink' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "GL")) Module["GL"] = function() { abort("'GL' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "dynamicAlloc")) Module["dynamicAlloc"] = function() { abort("'dynamicAlloc' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "loadDynamicLibrary")) Module["loadDynamicLibrary"] = function() { abort("'loadDynamicLibrary' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "loadWebAssemblyModule")) Module["loadWebAssemblyModule"] = function() { abort("'loadWebAssemblyModule' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getLEB")) Module["getLEB"] = function() { abort("'getLEB' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getFunctionTables")) Module["getFunctionTables"] = function() { abort("'getFunctionTables' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "alignFunctionTables")) Module["alignFunctionTables"] = function() { abort("'alignFunctionTables' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerFunctions")) Module["registerFunctions"] = function() { abort("'registerFunctions' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addFunction")) Module["addFunction"] = function() { abort("'addFunction' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "removeFunction")) Module["removeFunction"] = function() { abort("'removeFunction' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getFuncWrapper")) Module["getFuncWrapper"] = function() { abort("'getFuncWrapper' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "prettyPrint")) Module["prettyPrint"] = function() { abort("'prettyPrint' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "makeBigInt")) Module["makeBigInt"] = function() { abort("'makeBigInt' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "dynCall")) Module["dynCall"] = function() { abort("'dynCall' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getCompilerSetting")) Module["getCompilerSetting"] = function() { abort("'getCompilerSetting' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackSave")) Module["stackSave"] = function() { abort("'stackSave' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackRestore")) Module["stackRestore"] = function() { abort("'stackRestore' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackAlloc")) Module["stackAlloc"] = function() { abort("'stackAlloc' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "establishStackSpace")) Module["establishStackSpace"] = function() { abort("'establishStackSpace' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "print")) Module["print"] = function() { abort("'print' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "printErr")) Module["printErr"] = function() { abort("'printErr' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getTempRet0")) Module["getTempRet0"] = function() { abort("'getTempRet0' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setTempRet0")) Module["setTempRet0"] = function() { abort("'setTempRet0' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "callMain")) Module["callMain"] = function() { abort("'callMain' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "Pointer_stringify")) Module["Pointer_stringify"] = function() { abort("'Pointer_stringify' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "warnOnce")) Module["warnOnce"] = function() { abort("'warnOnce' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "intArrayFromBase64")) Module["intArrayFromBase64"] = function() { abort("'intArrayFromBase64' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "tryParseAsDataURI")) Module["tryParseAsDataURI"] = function() { abort("'tryParseAsDataURI' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") };if (!Object.getOwnPropertyDescriptor(Module, "ALLOC_NORMAL")) Object.defineProperty(Module, "ALLOC_NORMAL", { get: function() { abort("'ALLOC_NORMAL' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Object.getOwnPropertyDescriptor(Module, "ALLOC_STACK")) Object.defineProperty(Module, "ALLOC_STACK", { get: function() { abort("'ALLOC_STACK' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Object.getOwnPropertyDescriptor(Module, "ALLOC_DYNAMIC")) Object.defineProperty(Module, "ALLOC_DYNAMIC", { get: function() { abort("'ALLOC_DYNAMIC' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Object.getOwnPropertyDescriptor(Module, "ALLOC_NONE")) Object.defineProperty(Module, "ALLOC_NONE", { get: function() { abort("'ALLOC_NONE' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Object.getOwnPropertyDescriptor(Module, "calledRun")) Object.defineProperty(Module, "calledRun", { get: function() { abort("'calledRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") } });

if (memoryInitializer) {
  if (!isDataURI(memoryInitializer)) {
    memoryInitializer = locateFile(memoryInitializer);
  }
  if (ENVIRONMENT_IS_NODE || ENVIRONMENT_IS_SHELL) {
    var data = readBinary(memoryInitializer);
    HEAPU8.set(data, GLOBAL_BASE);
  } else {
    addRunDependency('memory initializer');
    var applyMemoryInitializer = function(data) {
      if (data.byteLength) data = new Uint8Array(data);
      for (var i = 0; i < data.length; i++) {
        assert(HEAPU8[GLOBAL_BASE + i] === 0, "area for memory initializer should not have been touched before it's loaded");
      }
      HEAPU8.set(data, GLOBAL_BASE);
      // Delete the typed array that contains the large blob of the memory initializer request response so that
      // we won't keep unnecessary memory lying around. However, keep the XHR object itself alive so that e.g.
      // its .status field can still be accessed later.
      if (Module['memoryInitializerRequest']) delete Module['memoryInitializerRequest'].response;
      removeRunDependency('memory initializer');
    };
    var doBrowserLoad = function() {
      readAsync(memoryInitializer, applyMemoryInitializer, function() {
        throw 'could not load memory initializer ' + memoryInitializer;
      });
    };
    var memoryInitializerBytes = tryParseAsDataURI(memoryInitializer);
    if (memoryInitializerBytes) {
      applyMemoryInitializer(memoryInitializerBytes.buffer);
    } else
    if (Module['memoryInitializerRequest']) {
      // a network request has already been created, just use that
      var useRequest = function() {
        var request = Module['memoryInitializerRequest'];
        var response = request.response;
        if (request.status !== 200 && request.status !== 0) {
          var data = tryParseAsDataURI(Module['memoryInitializerRequestURL']);
          if (data) {
            response = data.buffer;
          } else {
            // If you see this warning, the issue may be that you are using locateFile and defining it in JS. That
            // means that the HTML file doesn't know about it, and when it tries to create the mem init request early, does it to the wrong place.
            // Look in your browser's devtools network console to see what's going on.
            console.warn('a problem seems to have happened with Module.memoryInitializerRequest, status: ' + request.status + ', retrying ' + memoryInitializer);
            doBrowserLoad();
            return;
          }
        }
        applyMemoryInitializer(response);
      };
      if (Module['memoryInitializerRequest'].response) {
        setTimeout(useRequest, 0); // it's already here; but, apply it asynchronously
      } else {
        Module['memoryInitializerRequest'].addEventListener('load', useRequest); // wait for it
      }
    } else {
      // fetch it from the network ourselves
      doBrowserLoad();
    }
  }
}


var calledRun;


/**
 * @constructor
 * @this {ExitStatus}
 */
function ExitStatus(status) {
  this.name = "ExitStatus";
  this.message = "Program terminated with exit(" + status + ")";
  this.status = status;
}

var calledMain = false;

dependenciesFulfilled = function runCaller() {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!calledRun) run();
  if (!calledRun) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
};

function callMain(args) {
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
  assert(__ATPRERUN__.length == 0, 'cannot call main when preRun functions remain to be called');


  args = args || [];

  var argc = args.length+1;
  var argv = stackAlloc((argc + 1) * 4);
  HEAP32[argv >> 2] = allocateUTF8OnStack(thisProgram);
  for (var i = 1; i < argc; i++) {
    HEAP32[(argv >> 2) + i] = allocateUTF8OnStack(args[i - 1]);
  }
  HEAP32[(argv >> 2) + argc] = 0;


  try {


    var ret = Module['_main'](argc, argv);


    // if we're not running an evented main loop, it's time to exit
      exit(ret, /* implicit = */ true);
  }
  catch(e) {
    if (e instanceof ExitStatus) {
      // exit() throws this once it's done to make sure execution
      // has been stopped completely
      return;
    } else if (e == 'SimulateInfiniteLoop') {
      // running an evented main loop, don't immediately exit
      noExitRuntime = true;
      return;
    } else {
      var toLog = e;
      if (e && typeof e === 'object' && e.stack) {
        toLog = [e, e.stack];
      }
      err('exception thrown: ' + toLog);
      quit_(1, e);
    }
  } finally {
    calledMain = true;
  }
}




/** @type {function(Array=)} */
function run(args) {
  args = args || arguments_;

  if (runDependencies > 0) {
    return;
  }

  writeStackCookie();

  preRun();

  if (runDependencies > 0) return; // a preRun added a dependency, run will be called later

  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    if (calledRun) return;
    calledRun = true;

    if (ABORT) return;

    initRuntime();

    preMain();

    if (Module['onRuntimeInitialized']) Module['onRuntimeInitialized']();

    if (shouldRunNow) callMain(args);

    postRun();
  }

  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(function() {
      setTimeout(function() {
        Module['setStatus']('');
      }, 1);
      doRun();
    }, 1);
  } else
  {
    doRun();
  }
  checkStackCookie();
}
Module['run'] = run;

function checkUnflushedContent() {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var print = out;
  var printErr = err;
  var has = false;
  out = err = function(x) {
    has = true;
  }
  try { // it doesn't matter if it fails
    var flush = Module['_fflush'];
    if (flush) flush(0);
    // also flush in the JS FS layer
    ['stdout', 'stderr'].forEach(function(name) {
      var info = FS.analyzePath('/dev/' + name);
      if (!info) return;
      var stream = info.object;
      var rdev = stream.rdev;
      var tty = TTY.ttys[rdev];
      if (tty && tty.output && tty.output.length) {
        has = true;
      }
    });
  } catch(e) {}
  out = print;
  err = printErr;
  if (has) {
    warnOnce('stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the FAQ), or make sure to emit a newline when you printf etc.');
  }
}

function exit(status, implicit) {
  checkUnflushedContent();

  // if this is just main exit-ing implicitly, and the status is 0, then we
  // don't need to do anything here and can just leave. if the status is
  // non-zero, though, then we need to report it.
  // (we may have warned about this earlier, if a situation justifies doing so)
  if (implicit && noExitRuntime && status === 0) {
    return;
  }

  if (noExitRuntime) {
    // if exit() was called, we may warn the user if the runtime isn't actually being shut down
    if (!implicit) {
      err('exit(' + status + ') called, but EXIT_RUNTIME is not set, so halting execution but not exiting the runtime or preventing further async execution (build with EXIT_RUNTIME=1, if you want a true shutdown)');
    }
  } else {

    ABORT = true;
    EXITSTATUS = status;

    exitRuntime();

    if (Module['onExit']) Module['onExit'](status);
  }

  quit_(status, new ExitStatus(status));
}

var abortDecorators = [];

function abort(what) {
  if (Module['onAbort']) {
    Module['onAbort'](what);
  }

  what += '';
  out(what);
  err(what);

  ABORT = true;
  EXITSTATUS = 1;

  var extra = '';
  var output = 'abort(' + what + ') at ' + stackTrace() + extra;
  if (abortDecorators) {
    abortDecorators.forEach(function(decorator) {
      output = decorator(output, what);
    });
  }
  throw output;
}
Module['abort'] = abort;

if (Module['preInit']) {
  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
  while (Module['preInit'].length > 0) {
    Module['preInit'].pop()();
  }
}

// shouldRunNow refers to calling main(), not run().
var shouldRunNow = true;

if (Module['noInitialRun']) shouldRunNow = false;


  noExitRuntime = true;

run();





// {{MODULE_ADDITIONS}}



