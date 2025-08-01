/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * TVM JS Wasm Runtime library.
 */
import { Pointer, PtrOffset, SizeOf, TypeIndex } from "./ctypes";
import { Disposable } from "./types";
import { Memory, CachedCallStack } from "./memory";
import { assert, StringToUint8Array, LinearCongruentialGenerator } from "./support";
import { Environment } from "./environment";
import { AsyncifyHandler } from "./asyncify";
import { FunctionInfo, WebGPUContext } from "./webgpu";
import {
  ArtifactCache,
  ArtifactCacheTemplate,
  ArtifactIndexedDBCache,
  NDArrayShardEntry,
} from "./artifact_cache";
import * as compact from "./compact";
import * as ctypes from "./ctypes";

/**
 * Type for PackedFunc in the TVMRuntime.
 */
export type PackedFunc = ((...args: any) => any) &
  Disposable & { _tvmPackedCell: PackedFuncCell };

/**
 * Type for AyncPackedFunc in TVMRuntime
 * possibly may contain stack unwinding through Asynctify
 */
export type AsyncPackedFunc = ((...args: any) => Promise<any>) &
  Disposable & { _tvmPackedCell: PackedFuncCell };

/**
 * @internal
 * FFI Library wrapper, maintains most runtime states.
 */
class FFILibrary implements Disposable {
  wasm32: boolean;
  memory: Memory;
  exports: Record<string, Function>;
  webGPUContext?: WebGPUContext;
  private wasmInstance: WebAssembly.Instance;
  private recycledCallStacks: Array<CachedCallStack> = [];

  constructor(
    wasmInstance: WebAssembly.Instance,
    imports: Record<string, any>
  ) {
    this.wasmInstance = wasmInstance;
    this.memory = new Memory(this.detectWasmMemory(this.wasmInstance, imports));
    assert(
      this.wasmInstance.exports !== undefined,
      "Expect the library module contains exports"
    );
    this.exports = this.wasmInstance.exports as Record<string, Function>;
    this.wasm32 = this.memory.wasm32;
    this.validateInstance();
  }

  dispose(): void {
    while (this.recycledCallStacks.length != 0) {
      (this.recycledCallStacks.pop() as Disposable).dispose();
    }
    this.webGPUContext?.dispose();
  }

  sizeofPtr(): number {
    return this.memory.sizeofPtr();
  }

  checkCall(code: number): void {
    if (code != 0) {
      const msgPtr = (this.exports
        .TVMFFIWasmGetLastError as ctypes.FTVMFFIWasmGetLastError)();
      throw new Error(this.memory.loadCString(msgPtr));
    }
  }

  getOrAllocCallStack(): CachedCallStack {
    if (this.recycledCallStacks.length != 0) {
      return this.recycledCallStacks.pop() as CachedCallStack;
    }
    return new CachedCallStack(
      this.memory,
      this.exports.TVMWasmAllocSpace as ctypes.FTVMWasmAllocSpace,
      this.exports.TVMWasmFreeSpace as ctypes.FTVMWasmFreeSpace
    );
  }

  recycleCallStack(callstack: CachedCallStack): void {
    callstack.reset();
    this.recycledCallStacks.push(callstack);
  }

  private validateInstance(): void {
    this.checkExports(["TVMWasmAllocSpace", "TVMWasmFreeSpace"]);
  }

  private checkExports(funcNames: Array<string>): void {
    const missList = [];
    for (const name of funcNames) {
      const f = this.exports[name];
      if (!(f instanceof Function)) {
        missList.push(name);
      }
    }
    if (missList.length != 0) {
      throw new Error("Cannot find " + missList + " in exports");
    }
  }

  private detectWasmMemory(
    instance: WebAssembly.Instance,
    imports: Record<string, any>
  ): WebAssembly.Memory {
    if (instance.exports.memory instanceof WebAssembly.Memory) {
      return instance.exports.memory;
    }
    if (imports.env && imports.env.memory instanceof WebAssembly.Memory) {
      return imports.env.memory;
    }

    throw new Error(
      "Cannt detect wasm memory from imports " +
      imports +
      " or exports" +
      instance.exports
    );
  }
}

/**
 * @internal
 * Manages extra runtime context for the runtime.
 */
class RuntimeContext implements Disposable {
  functionListGlobalNamesFunctor: PackedFunc;
  moduleGetFunction: PackedFunc;
  moduleImport: PackedFunc;
  ndarrayEmpty: PackedFunc;
  ndarrayCopyFromTo: PackedFunc;
  ndarrayCopyFromJSBytes: PackedFunc;
  ndarrayCopyToJSBytes: PackedFunc;
  arrayGetItem: PackedFunc;
  arrayGetSize: PackedFunc;
  arrayMake: PackedFunc;
  arrayConcat: PackedFunc;
  getSysLib: PackedFunc;
  arrayCacheGet: PackedFunc;
  arrayCacheUpdate: PackedFunc;
  arrayCacheRemove: PackedFunc;
  arrayCacheClear: PackedFunc;
  arrayDecodeStorage: PackedFunc;
  paramModuleFromCache: PackedFunc;
  paramModuleFromCacheByName: PackedFunc;
  makeShapeTuple: PackedFunc;
  ndarrayCreateView: PackedFunc;
  sampleTopPFromLogits: PackedFunc;
  sampleTopPFromProb: PackedFunc;
  applyRepetitionPenalty: PackedFunc;
  applyPresenceAndFrequencyPenalty: PackedFunc;
  applySoftmaxWithTemperature: PackedFunc;
  concatEmbeddings: PackedFunc | undefined;
  bool: PackedFunc;
  private autoDisposeScope: Array<Array<Disposable | undefined>> = [];

  constructor(
    getGlobalFunc: (name: string) => PackedFunc
  ) {
    this.functionListGlobalNamesFunctor = getGlobalFunc(
      "ffi.FunctionListGlobalNamesFunctor"
    );
    this.moduleGetFunction = getGlobalFunc("runtime.ModuleGetFunction");
    this.moduleImport = getGlobalFunc("runtime.ModuleImport");
    this.ndarrayEmpty = getGlobalFunc("runtime.TVMArrayAllocWithScope");
    this.ndarrayCopyFromTo = getGlobalFunc("runtime.TVMArrayCopyFromTo");
    this.ndarrayCopyFromJSBytes = getGlobalFunc("tvmjs.runtime.NDArrayCopyFromBytes");
    this.ndarrayCopyToJSBytes = getGlobalFunc("tvmjs.runtime.NDArrayCopyToBytes");
    this.arrayGetItem = getGlobalFunc("ffi.ArrayGetItem");
    this.arrayGetSize = getGlobalFunc("ffi.ArraySize");
    this.arrayMake = getGlobalFunc("ffi.Array");
    this.arrayConcat = getGlobalFunc("tvmjs.runtime.ArrayConcat");
    this.getSysLib = getGlobalFunc("runtime.SystemLib");
    this.arrayCacheGet = getGlobalFunc("vm.builtin.ndarray_cache.get");
    this.arrayCacheRemove = getGlobalFunc("vm.builtin.ndarray_cache.remove");
    this.arrayCacheUpdate = getGlobalFunc("vm.builtin.ndarray_cache.update");
    this.arrayCacheClear = getGlobalFunc("vm.builtin.ndarray_cache.clear");
    this.arrayDecodeStorage = getGlobalFunc("tvmjs.array.decode_storage");
    this.paramModuleFromCache = getGlobalFunc("vm.builtin.param_module_from_cache");
    this.paramModuleFromCacheByName = getGlobalFunc("vm.builtin.param_module_from_cache_by_name");
    this.makeShapeTuple = getGlobalFunc("ffi.Shape");
    this.ndarrayCreateView = getGlobalFunc("runtime.TVMArrayCreateView");
    this.sampleTopPFromLogits = getGlobalFunc("vm.builtin.sample_top_p_from_logits");
    this.sampleTopPFromProb = getGlobalFunc("vm.builtin.sample_top_p_from_prob");
    this.applyRepetitionPenalty = getGlobalFunc("vm.builtin.apply_repetition_penalty");
    this.applyPresenceAndFrequencyPenalty = getGlobalFunc("vm.builtin.apply_presence_and_frequency_penalty");
    this.applySoftmaxWithTemperature = getGlobalFunc("vm.builtin.apply_softmax_with_temperature");
    this.concatEmbeddings = getGlobalFunc("tvmjs.runtime.ConcatEmbeddings");
  }

  dispose(): void {
    // call array cache clear to clear all cached items
    this.arrayCacheClear.dispose();
    this.arrayGetItem.dispose();
    this.arrayGetSize.dispose();
    this.arrayMake.dispose();
    this.arrayConcat.dispose();
    this.arrayCacheGet.dispose();
    this.arrayCacheRemove.dispose();
    this.arrayCacheUpdate.dispose();
    this.arrayCacheClear.dispose();
    this.arrayDecodeStorage.dispose();
    this.paramModuleFromCache.dispose();
    this.paramModuleFromCacheByName.dispose();
    this.makeShapeTuple.dispose();
    this.ndarrayCreateView.dispose();
    this.sampleTopPFromLogits.dispose();
    this.applyRepetitionPenalty.dispose();
    this.applyPresenceAndFrequencyPenalty.dispose();
    this.applySoftmaxWithTemperature.dispose();
    this.concatEmbeddings?.dispose();
  }

  beginScope(): void {
    this.autoDisposeScope.push([]);
  }

  endScope(): void {
    if (this.autoDisposeScope.length === 0) {
      throw Error("tvm.endScope called when the stack is empty.");
    }
    // automatically dispose all the tracked values in the current scope.
    const currScope = this.autoDisposeScope.pop() as Array<Disposable | undefined>;
    for (let i = 0; i < currScope.length; ++i) {
      const val = currScope[i];
      if (val !== undefined) {
        val.dispose();
      }
    }
  }

  /**
   * Track object for dispose in current scope.
   *
   * @param obj The object to be tracked.
   * @returns the same object.
   * @note This function only needs to be called for raw system C API values.
   *       The return value of PackedFunc will be automatically tracked.
   */
  attachToCurrentScope<T extends Disposable>(obj: T): T {
    if (this.autoDisposeScope.length === 0) {
      throw Error("Must call beginScope to use functions that returns TVM objects");
    }
    const currScope = this.autoDisposeScope[this.autoDisposeScope.length - 1];
    currScope.push(obj);
    return obj;
  }

  moveToParentScope<T extends Disposable>(obj: T): T {
    this.detachFromCurrentScope(obj);
    if (this.autoDisposeScope.length < 2) {
      throw Error("moveToParentScope: Parent scope do not exist");
    }
    const parentScope = this.autoDisposeScope[this.autoDisposeScope.length - 2];
    parentScope.push(obj);
    return obj;
  }

  detachFromCurrentScope<T extends Disposable>(obj: T): T {
    const currScope = this.autoDisposeScope[this.autoDisposeScope.length - 1];
    let occurrence = 0;
    for (let i = 0; i < currScope.length; ++i) {
      if (currScope[i] === obj) {
        occurrence += 1;
        currScope[i] = undefined;
      }
    }
    if (occurrence === 0) {
      throw Error("Cannot find obj in the current auto conversion pool");
    }
    if (occurrence > 1) {
      throw Error("Value attached to scope multiple times");
    }
    return obj;
  }
}

/**
 * A typed scalar constant used to represent a typed number
 * argument to PackedFunc calls.
 */
export class Scalar {
  /** The value. */
  value: number;
  /** The data type of the scalar. */
  dtype: string;

  constructor(value: number, dtype: string) {
    this.value = value;
    this.dtype = dtype;
  }
}

const DeviceEnumToStr: Record<number, string> = {
  1: "cpu",
  2: "cuda",
  4: "opencl",
  8: "metal",
  15: "webgpu"
};

const DeviceStrToEnum: Record<string, number> = {
  cpu: 1,
  cuda: 2,
  cl: 4,
  opencl: 4,
  vulkan: 7,
  metal: 8,
  webgpu: 15
};

/**
 * Represent a runtime context where a NDArray can reside.
 */
export class DLDevice {
  /** The device type code of the device. */
  deviceType: number;
  /** The device index. */
  deviceId: number;

  private lib: FFILibrary;

  constructor(deviceType: number | string, deviceId: number, lib: FFILibrary) {
    const tp = typeof deviceType;
    if (tp === "string") {
      this.deviceType = DeviceStrToEnum[deviceType];
      if (this.deviceType === undefined) {
        throw new Error("Cannot recogonize deviceType " + deviceType);
      }
    } else if (tp === "number") {
      this.deviceType = deviceType as number;
    } else {
      throw new Error("Cannot take type " + tp + " as deviceType");
    }
    this.deviceId = deviceId;
    this.lib = lib;
  }

  /**
   * Synchronize the device
   */
  async sync(): Promise<void> {
    if (this.deviceType === DeviceStrToEnum.webgpu) {
      assert(this.lib.webGPUContext !== undefined);
      await this.lib.webGPUContext.sync();
    }
  }

  toString(): string {
    return (
      DeviceEnumToStr[this.deviceType] + ":" + this.deviceId.toString()
    );
  }
}
/**
 * The data type code in DLDataType
 */
export enum DLDataTypeCode {
  Int = 0,
  UInt = 1,
  Float = 2,
  OpaqueHandle = 3
}

const DLDataTypeCodeToStr: Record<number, string> = {
  0: "int",
  1: "uint",
  2: "float",
  3: "handle",
};

/**
 * Runtime data type of NDArray.
 */
export class DLDataType {
  /** The type code */
  code: number;
  /** Number of bits in the data type. */
  bits: number;
  /** Number of vector lanes. */
  lanes: number;

  constructor(code: number, bits: number, lanes: number) {
    this.code = code;
    this.bits = bits;
    this.lanes = lanes;
  }

  toString(): string {
    const ret = DLDataTypeCodeToStr[this.code] + this.bits.toString();
    if (this.lanes != 1) {
      return ret + "x" + this.lanes.toString();
    } else {
      return ret;
    }
  }

  numStorageBytes(): number {
    return (this.bits * this.lanes + 7) >> 3;
  }
}

/**
 * Generic object base
 */
export class TVMObject implements Disposable {
  protected handle: Pointer;
  protected lib: FFILibrary;
  protected ctx: RuntimeContext;

  constructor(
    handle: Pointer,
    lib: FFILibrary,
    ctx: RuntimeContext
  ) {
    this.handle = handle;
    this.lib = lib;
    this.ctx = ctx;
  }

  dispose(): void {
    if (this.handle != 0) {
      this.lib.checkCall(
        (this.lib.exports.TVMFFIObjectFree as ctypes.FTVMFFIObjectFree)(this.handle)
      );
      this.handle = 0;
    }
  }

  /**
   * Get handle of module, check it is not null.
   *
   * @param requireNotNull require handle is not null.
   * @returns The handle.
   */
  getHandle(requireNotNull = true): Pointer {
    if (requireNotNull && this.handle === 0) {
      throw Error("Object has already been disposed");
    }
    return this.handle;
  }

  /** get the type index of the object */
  typeIndex(): number {
    if (this.handle === 0) {
      throw Error("The current Object has already been disposed");
    }
    return this.lib.memory.loadObjectTypeIndex(this.handle);
  }

  /** get the type key of the object */
  typeKey(): string {
    const type_index = this.typeIndex();
    const typeInfoPtr = (this.lib.exports.TVMFFIGetTypeInfo as ctypes.FTVMFFIGetTypeInfo)(
      type_index
    );
    return this.lib.memory.loadTypeInfoTypeKey(typeInfoPtr);
  }
}

/**
 * Cell holds the PackedFunc object.
 */
class PackedFuncCell extends TVMObject {
  constructor(handle: Pointer, lib: FFILibrary, ctx: RuntimeContext) {
    super(handle, lib, ctx);
  }
}

/**
 * n-dimnesional array.
 */

export class NDArray extends TVMObject {
  /** Number of dimensions. */
  ndim: number;
  /** Data type of the array. */
  dtype: string;
  /** Shape of the array. */
  shape: Array<number>;
  /** Device of the array. */
  device: DLDevice;
  /** Whether it is a temporary view that can become invalid after the call. */
  isView: boolean;
  private byteOffset: number;
  private dltensor: Pointer;
  private dataPtr: Pointer;
  private dlDataType: DLDataType;

  constructor(handle: Pointer, lib: FFILibrary, ctx: RuntimeContext, isView: boolean) {
    // if the array is a view, we need to create a new object with a null handle
    // so dispose won't trigger memory free
    const objectHandle = isView ? 0 : handle;
    super(objectHandle, lib, ctx);
    this.isView = isView;
    if (this.isView) {
      this.dltensor = handle;
    } else {
      this.dltensor = this.getDLTensorFromArrayHandle(this.handle);
    }
    // constant offsets.
    const arrayOffsetData = 0;
    const arrayOffsetContext = arrayOffsetData + this.lib.sizeofPtr();
    const arrayOffsetDevType = arrayOffsetContext;
    const arrayOffsetDevId = arrayOffsetContext + SizeOf.I32;
    const arrayOffsetNdim = arrayOffsetContext + SizeOf.DLDevice;
    const arrayOffsetDtype = arrayOffsetNdim + SizeOf.I32;
    const arrayOffsetDtypeCode = arrayOffsetDtype;
    const arrayOffsetDtypeBits = arrayOffsetDtype + SizeOf.U8;
    const arrayOffsetDtypeLanes = arrayOffsetDtypeBits + SizeOf.U8;
    const arrayOffsetShape = arrayOffsetDtype + SizeOf.DLDataType;
    const arrayOffsetStrides = arrayOffsetShape + this.lib.sizeofPtr();
    const arrayOffsetByteOffset = arrayOffsetStrides + this.lib.sizeofPtr();
    // dataPtr
    this.dataPtr = lib.memory.loadPointer(this.dltensor);
    // ndim
    this.ndim = lib.memory.loadI32(this.dltensor + arrayOffsetNdim);
    // shape
    const cshapePtr = lib.memory.loadPointer(this.dltensor + arrayOffsetShape);
    this.shape = [];
    for (let i = 0; i < this.ndim; ++i) {
      this.shape.push(lib.memory.loadI64(cshapePtr + i * SizeOf.I64));
    }
    // dtype
    const code = lib.memory.loadU8(this.dltensor + arrayOffsetDtypeCode);
    const bits = lib.memory.loadU8(this.dltensor + arrayOffsetDtypeBits);
    const lanes = lib.memory.loadU16(this.dltensor + arrayOffsetDtypeLanes);
    this.dlDataType = new DLDataType(code, bits, lanes);
    this.dtype = this.dlDataType.toString();

    // device
    const deviceType = lib.memory.loadI32(this.dltensor + arrayOffsetDevType);
    const deviceId = lib.memory.loadI32(this.dltensor + arrayOffsetDevId);
    this.device = new DLDevice(deviceType, deviceId, lib);

    // byte_offset
    this.byteOffset = lib.memory.loadI64(this.dltensor + arrayOffsetByteOffset);
  }

  /**
   * Create a view of the array.
   * @param shape The shape of the view.
   * @param dtype The data type of the new array.
   * @returns The new sliced ndarray.
   */
  view(shape: Array<number>, dtype?: string): NDArray {
    const shapeArray = shape.map((value) => new Scalar(value, "int"));
    if (dtype === undefined) {
      dtype = this.dtype;
    }
    return this.ctx.ndarrayCreateView(
      this,
      this.ctx.makeShapeTuple(...shapeArray),
      this.dtype,
      /*relative_byte_offset=*/ new Scalar(0, "int"),
    );
  }
  /**
   * Get dataPtr of NDarray
   *
   * @returns The handle.
   */
  getDataPtr(): Pointer {
    if (this.handle === 0) {
      throw Error("NDArray has already been disposed");
    }
    return this.dataPtr;
  }

  /**
   * Copy data from another NDArray or javascript array.
   * The number of elements must match.
   *
   * @param data The source data array.
   * @returns this
   */
  copyFrom(
    data: NDArray | Array<number> | Float32Array | Float64Array |
      Int32Array | Int8Array | Uint8Array | Uint8ClampedArray
  ): this {
    if (data instanceof NDArray) {
      this.ctx.ndarrayCopyFromTo(data, this);
      return this;
    } else {
      const size = this.shape.reduce((a, b) => {
        return a * b;
      }, 1);
      if (data.length != size) {
        throw new Error(
          "data size and shape mismatch data.length" +
          data.length +
          " vs " +
          size
        );
      }
      let buffer: ArrayBuffer;
      if (this.dtype === "float32") {
        buffer = Float32Array.from(data).buffer;
      } else if (this.dtype === "float64") {
        buffer = Float64Array.from(data).buffer;
      } else if (this.dtype === "int32") {
        buffer = Int32Array.from(data).buffer;
      } else if (this.dtype === "int8") {
        buffer = Int8Array.from(data).buffer;
      } else if (this.dtype === "uint8") {
        buffer = Uint8Array.from(data).buffer;
      } else if (this.dtype === "uint32") {
        buffer = Uint32Array.from(data).buffer;
      } else {
        throw new Error("Unsupported data type " + this.dtype);
      }
      return this.copyFromRawBytes(new Uint8Array(buffer));
    }
  }
  /**
   * Copy data from raw bytes.
   * @param data Uint8Array of bytes.
   * @returns this
   */
  copyFromRawBytes(data: Uint8Array): this {
    // short cut for gpu copy
    if (this.device.deviceType === DeviceStrToEnum.webgpu) {
      this.lib.webGPUContext?.copyRawBytesToBuffer(data, this.getDataPtr(), 0, data.length);
      return this;
    }
    // CPU copy
    const size = this.shape.reduce((a, b) => {
      return a * b;
    }, 1);
    const nbytes = this.dlDataType.numStorageBytes() * size;
    if (nbytes != data.length) {
      throw new Error("Expect the data's length equals nbytes=" + nbytes);
    }
    this.ctx.ndarrayCopyFromJSBytes(this, data);
    return this;
  }
  /**
   * Return a copied Uint8Array of the raw bytes in the NDArray.
   * @returns The result array.
   */
  toRawBytes(): Uint8Array {
    if (this.device.deviceType != DeviceStrToEnum.cpu) {
      throw new Error("Can only sync copy CPU array, use cpu_arr.copyfrom(gpu_arr) then sync instead.");
    }
    return this.ctx.ndarrayCopyToJSBytes(this) as Uint8Array;
  }

  /**
   * Return a TypedArray copy of the NDArray, the specific type depends on
   * the dtype of the NDArray.
   * @returns The result array.
   */
  toArray(): Float32Array | Float64Array | Int32Array | Int8Array | Uint8Array {
    const stype = this.dtype;
    if (stype === "float32") {
      return new Float32Array(this.toRawBytes().buffer);
    } else if (stype === "float64") {
      return new Float64Array(this.toRawBytes().buffer);
    } else if (stype === "int32") {
      return new Int32Array(this.toRawBytes().buffer);
    } else if (stype === "int8") {
      return new Int8Array(this.toRawBytes().buffer);
    } else if (stype === "uint8") {
      return new Uint8Array(this.toRawBytes().buffer);
    } else {
      throw new Error("Unsupported data type " + this.dtype);
    }
  }

  private getDLTensorFromArrayHandle(handle: Pointer): Pointer {
    return handle + SizeOf.ObjectHeader;
  }
}


/**
 * Runtime Module.
 */
export class Module extends TVMObject {
  constructor(
    handle: Pointer,
    lib: FFILibrary,
    ctx: RuntimeContext,
  ) {
    super(handle, lib, ctx);
  }
  /**
   * Get a function in the module.
   * @param name The name of the function.
   * @param queryImports Whether to also query imports
   * @returns The result function.
   */
  getFunction(name: string, queryImports = true): PackedFunc {
    return this.ctx.moduleGetFunction(this, name, queryImports) as PackedFunc;
  }

  /**
   * Import another module into the current runtime module.
   * @param mod The module to be imported.
   */
  importModule(mod: Module): void {
    this.ctx.moduleImport(this, mod);
  }
}


/** Objectconstructor */
type FObjectConstructor = (handle: Pointer, lib: FFILibrary, ctx: RuntimeContext) => TVMObject;

/** All possible object types. */
type TVMObjectBase = TVMObject | PackedFunc;

/** Runtime array object. */
export class TVMArray extends TVMObject {
  constructor(
    handle: Pointer,
    lib: FFILibrary,
    ctx: RuntimeContext
  ) {
    super(handle, lib, ctx);
  }

  /**
   * @returns the size of the array.
   */
  size(): number {
    return this.ctx.arrayGetSize(this) as number;
  }
  /**
   * Get index-th element of the array
   * @param index the array index.
   * @returns The element.
   */
  get(index: number): TVMObjectBase {
    return this.ctx.arrayGetItem(this, new Scalar(index, "int32")) as TVMObjectBase;
  }
}

export enum VMAllocatorKind {
  NAIVE_ALLOCATOR = 1,
  POOLED_ALLOCATOR = 2,
}

/**
 *  VirtualMachine Executor.
 *
 *  This is a thin wrapper of the underlying TVM module.
 *  you can also directly call set_input, run, and get_output
 *  of underlying module functions
 */
export class VirtualMachine implements Disposable {
  private mod: Module;
  /**
   * Constructor
   * @param mod The underlying module, need to be detached.
   * @param device The main device ro run VM on.
   */
  constructor(mod: Module, device: DLDevice) {
    this.mod = mod;
    this.mod.getFunction("vm_initialization")(
      new Scalar(device.deviceType, "int"),
      new Scalar(device.deviceId, "int"),
      new Scalar(VMAllocatorKind.POOLED_ALLOCATOR, "int"),
      // explicitly specify host device type
      new Scalar(DeviceStrToEnum.cpu, "int"),
      new Scalar(0, "int"),
      new Scalar(VMAllocatorKind.POOLED_ALLOCATOR, "int"),
    );
  }

  dispose(): void {
    this.mod.dispose();
  }
  /**
   * Get a function in the VM module.
   * @param name The name of the function.
   * @returns The result function.
   */
  getFunction(name: string): PackedFunc {
    return this.mod.getFunction(name);
  }

  /**
   * Get the internal module.
   */
  getInternalModule(): Module {
    return this.mod;
  }
}

/** Code used as the first argument of the async callback. */
enum AsyncCallbackCode {
  kReturn = 4,
  kException = 5,
}

export interface InitProgressReport {
  progress: number;
  timeElapsed: number;
  text: string;
}

export type InitProgressCallback = (report: InitProgressReport) => void;

/**
 * TVM runtime instance.
 *
 * All objects(NDArray, Module, PackedFunc) returned by TVM runtim function call
 * and PackedFunc instance are tracked through a scope mechanism that will get
 * auto-released when we call EndScope.
 *
 * This is necessarily to be able to release the underlying WASM and WebGPU memory that
 * are not tracked through JS native garbage collection mechanism.
 *
 * This does mean that we have to get familar with the following functions:
 * - {@link beginScope}
 * - {@link endScope}
 * - {@link withNewScope}
 * - {@link attachToCurrentScope}
 * - {@link detachFromCurrentScope}
 */
export class Instance implements Disposable {
  memory: Memory;
  exports: Record<string, Function>;
  cacheMetadata: Record<string, any> = {};
  private lib: FFILibrary;
  private env: Environment;
  private objFactory: Map<number, FObjectConstructor>;
  private ctx: RuntimeContext;
  private asyncifyHandler: AsyncifyHandler;
  private initProgressCallback: Array<InitProgressCallback> = [];
  private rng: LinearCongruentialGenerator;
  private deviceLostIsError = true;  // whether device.lost is due to actual error or dispose()

  /**
   * Internal function(registered by the runtime)
   */
  private wasmCreateLibraryModule?: PackedFunc &
    ((getFunc: PackedFunc, getGlobal: PackedFunc) => PackedFunc);

  /**
   * Constructor
   *
   * importObject can also be a {@link LibraryProvider} object,
   * a WASI object, or an object containing wasmLibraryProvider field.
   *
   * @param wasmModule The input module or instance.
   * @param importObject The imports to initialize the wasmInstance if it is not provided.
   * @param wasmInstance Additional wasm instance argument for deferred construction.
   * @param env Directly specified environment module.
   *
   * @see Please use the async version {@link instantiate} when targeting browsers.
   */
  constructor(
    wasmModule: WebAssembly.Module,
    importObject: Record<string, any> = {},
    wasmInstance?: WebAssembly.Instance,
    env?: Environment
  ) {
    if (wasmInstance instanceof WebAssembly.Instance) {
      assert(
        env instanceof Environment,
        "env must be provided when passing in instance"
      );
    } else {
      assert(env === undefined);
      env = new Environment(importObject);
      wasmInstance = new WebAssembly.Instance(wasmModule, env.imports);
    }
    env.start(wasmInstance);
    this.env = env;
    this.lib = new FFILibrary(wasmInstance, env.imports);
    this.memory = this.lib.memory;
    this.exports = this.lib.exports;
    this.asyncifyHandler = new AsyncifyHandler(this.exports, this.memory.memory);
    this.objFactory = new Map<number, ObjectConstructor>();
    this.ctx = new RuntimeContext(
      (name: string) => {
        const autoAttachToScope = false;
        // runtime context function do not auto-release.
        return this.getGlobalFuncInternal(name, autoAttachToScope);
      }
    );
    this.registerEnvGlobalPackedFuncs();
    this.registerObjectFactoryFuncs();
    this.rng = new LinearCongruentialGenerator();
  }

  /**
   * Benchmark stable execution of the run function.
   *
   * @params run The run function
   * @params dev The device to sync during each run.
   * @number The number of times to compute the average.
   * @repeat The number of times to repeat the run.
   */
  async benchmark(run: () => void, dev: DLDevice, number = 10, repeat = 1): Promise<number[]> {
    // Skip first run as it can involve GPU warmup and module loading time.
    const perf = compact.getPerformance();
    const results = [];

    // run with new scope
    this.withNewScope(run);
    await dev.sync();

    for (let k = 0; k < repeat; ++k) {
      const tstart = perf.now();
      for (let i = 0; i < number; ++i) {
        this.withNewScope(run);
      }
      await dev.sync();
      const tend = perf.now();
      results.push((tend - tstart) / number);
    }
    return results;
  }

  /**
   * Check whether we enabled asyncify mode
   * @returns The asynctify mode toggle
   */
  asyncifyEnabled(): boolean {
    return this.asyncifyHandler.enabled();
  }

  dispose(): void {
    this.deviceLostIsError = false;  // prevent dispose to trigger device.lost error
    // order matters
    // ctx release goes back into lib.
    this.ctx.dispose();
    this.lib.dispose();
    // Cannot set deviceLostIsError back to true here because GPUDevice.destroy() is asynchronous.
  }

  /**
   * Obtain the runtime information in readable format.
   */
  runtimeStatsText(): string {
    if (this.lib.webGPUContext !== undefined) {
      return this.lib.webGPUContext.runtimeStatsText();
    } else {
      return "";
    }
  }

  /**
   * Begin a new scope for tracking object disposal.
   */
  beginScope(): void {
    this.ctx.beginScope();
  }

  /**
   * End a scope and release all created TVM objects
   * under the current scope.
   *
   * Exception: one can call {@link moveToParentScope} to move
   * a value to parent scope.
   */
  endScope(): void {
    this.ctx.endScope();
  }

  /**
   * Perform action under a new scope.
   *
   * @param action The action function.
   * @returns The result value.
   *
   * @note For action to return a valid value,
   *       we will need to call {@link moveToParentScope}
   *       for the objects that are created in the scope.
   */
  withNewScope<T>(action: () => T): T {
    this.beginScope();
    const val = action();
    this.endScope();
    return val;
  }

  /**
   * Attach a detached obj to the auto-release pool of the current scope.
   *
   * @param obj The input obj.
   * @note Normally user do not need to call this function explicitly, as
   *       all library call return values are explicitly attached to
   *       the current scope. You only need to do so when you call
   *       {@link detachFromCurrentScope} to create a detached object.
   */
  attachToCurrentScope<T extends Disposable>(obj: T): T {
    return this.ctx.attachToCurrentScope(obj);
  }

  /**
   * Move obj's attachment to the parent scope.
   *
   * This function is useful to make sure objects are still
   * alive when exit the current scope.
   *
   * @param obj The object to be moved.
   * @returns The input obj.
   */
  moveToParentScope<T extends Disposable>(obj: T): T {
    return this.ctx.moveToParentScope(obj);
  }

  /**
   * Detach the object from the current scope
   * so it won't be released via auto-release during endscope.
   *
   * User needs to either explicitly call obj.dispose(), or
   * {@link attachToCurrentScope} to re-attach to the current scope.
   *
   * This function can be used to return values to the parent scope.
   * @param obj The object.
   */
  detachFromCurrentScope<T extends Disposable>(obj: T): T {
    return this.ctx.detachFromCurrentScope(obj);
  }

  /**
   * Get system-wide library module in the wasm.
   * System lib is a global module that contains self register functions in startup.
   * @returns The system library module.
   */
  systemLib(): Module {
    return this.ctx.getSysLib() as Module;
  }
  /**
   * List all the global function names registered in the runtime.
   * @returns The name list.
   */
  listGlobalFuncNames(): Array<string> {
    return this.withNewScope(() => {
      const functor = this.ctx.functionListGlobalNamesFunctor();
      const numNames = functor(new Scalar(-1, "int")) as number;
      const names = new Array<string>(numNames);
      for (let i = 0; i < numNames; i++) {
        names[i] = functor(new Scalar(i, "int")) as string;
      }
      return names;
    });
  }
  /**
   * Register function to be global function in tvm runtime.
   * @param name The name of the function.
   * @param f function to be registered.
   * @param override Whether overwrite function in existing registry.
   */
  registerFunc(
    name: string,
    func: PackedFunc | Function,
    override = false
  ): void {
    this.withNewScope(() => {
      const autoAttachToScope = true;
      // packed func can be released once it is registered
      const packedFunc = this.toPackedFuncInternal(func, autoAttachToScope);
      const ioverride = override ? 1 : 0;

      const stack = this.lib.getOrAllocCallStack();
      const nameOffset = stack.allocByteArrayForString(name);
      stack.commitToWasmMemory();
      this.lib.checkCall(
        (this.lib.exports.TVMFFIFunctionSetGlobal as ctypes.FTVMFFIFunctionSetGlobal)(
          stack.ptrFromOffset(nameOffset),
          packedFunc._tvmPackedCell.getHandle(),
          ioverride
        )
      );
      this.lib.recycleCallStack(stack);
    });
  }

  /**
   * Get global PackedFunc from the runtime.
   * @param name The name of the function.
   * @param autoAttachToScope Whether to track it via autoDispose
   * @returns The result function.
   */
  getGlobalFunc(name: string): PackedFunc {
    return this.getGlobalFuncInternal(name, true);
  }

  private getGlobalFuncInternal(name: string, autoAttachToScope = true): PackedFunc {
    const stack = this.lib.getOrAllocCallStack();
    const nameOffset = stack.allocByteArrayForString(name);
    const outOffset = stack.allocPtrArray(1);
    const outPtr = stack.ptrFromOffset(outOffset);

    stack.commitToWasmMemory(outOffset);

    this.lib.checkCall(
      (this.exports.TVMFFIFunctionGetGlobal as ctypes.FTVMFFIFunctionGetGlobal)(
        stack.ptrFromOffset(nameOffset),
        outPtr
      )
    );
    const handle = this.memory.loadPointer(outPtr);
    this.lib.recycleCallStack(stack);
    if (handle === 0) {
      throw Error("Cannot find global function " + name);
    }
    const ret = this.makePackedFunc(handle);
    if (autoAttachToScope) this.ctx.attachToCurrentScope(ret);
    return ret;
  }

  /**
   * Check if func is PackedFunc.
   *
   * @param func The input.
   * @returns The check result.
   */
  isPackedFunc(func: unknown): boolean {
    // eslint-disable-next-line no-prototype-builtins
    return typeof func === "function" && func.hasOwnProperty("_tvmPackedCell");
  }

  /**
   * Convert func to PackedFunc
   *
   * @param func Input function.
   * @returns The converted function.
   */
  toPackedFunc(func: Function): PackedFunc {
    return this.toPackedFuncInternal(func, true);
  }

  private toPackedFuncInternal(func: Function, autoAttachToScope: boolean): PackedFunc {
    if (this.isPackedFunc(func)) return func as PackedFunc;
    const ret = this.createPackedFuncFromSafeCallType(this.wrapJSFuncAsSafeCallType(func));
    if (autoAttachToScope) return this.ctx.attachToCurrentScope(ret);
    return ret;
  }

  /**
  * Setup a virtual machine module with given device.
  *
  * @param dev DLDevice the device.
  * @returns The created virtual machime.
  */
  createVirtualMachine(dev: DLDevice): VirtualMachine {
    const mod = this.ctx.detachFromCurrentScope(
      this.systemLib().getFunction("vm_load_executable")()
    );
    return this.ctx.attachToCurrentScope(
      new VirtualMachine(mod, dev)
    );
  }

  //-----------------------------------------------
  // Native NDArray Cache Support
  //-----------------------------------------------
  /**
   * Register a call back for fetch progress.
  *
   * @param cb the fetch progress callback.
   */
  registerInitProgressCallback(cb: InitProgressCallback) {
    this.initProgressCallback.push(cb);
  }

  /**
   * Get parameters in the form of prefix_i
   *
   * @param prefix The parameter prefix.
   * @param numParams  Number of parameters.
   * @returns
   */
  getParamsFromCache(prefix: string, numParams: number): TVMObject {
    return (this.ctx.paramModuleFromCache(
      prefix, new Scalar(numParams, "int32")) as Module).getFunction("get_params")();
  }

  /**
   * Get parameters based on parameter names provided
   *
   * @param paramNames Names of the parameters.
   * @returns Parameters read.
   */
  getParamsFromCacheByName(paramNames: Array<string>): TVMObject {
    return (this.ctx.paramModuleFromCacheByName(paramNames) as Module).getFunction("get_params")();
  }

  /**
   * Get NDArray from cache.
   * @param name  The name of array.
   * @returns  The result.
   */
  ndarrayCacheGet(name: string): NDArray | undefined {
    return this.ctx.arrayCacheGet(name);
  }

  /**
   * Get NDArray from cache.
   * @param name  The name of array.
   * @returns  The result.
   */
  ndarrayCacheRemove(name: string): NDArray | undefined {
    return this.ctx.arrayCacheRemove(name);
  }

  /**
   * Update the ndarray cache.
   * @param name The name of the array.
   * @param arr The content.
   */
  ndarrayCacheUpdate(name: string, arr: NDArray, override = false) {
    this.ctx.arrayCacheUpdate(name, arr, this.scalar(override ? 1 : 0, "int32"));
  }

  /**
   * Update the ndarray cache.
   * @param name The name of the array.
   * @param arr The content.
   */
  ndarrayCacheClear() {
    this.ctx.arrayCacheClear();
  }

  /**
   * Given cacheUrl, search up items to fetch based on cacheUrl/ndarray-cache.json
   *
   * @param ndarrayCacheUrl The cache url.
   * @param device The device to be fetched to.
   * @param cacheScope The scope identifier of the cache
   * @param cacheType The type of the cache: "cache" or "indexedDB"
   * @param signal An optional AbortSignal to abort the fetch
   * @returns The meta data
   */
  async fetchNDArrayCache(
    ndarrayCacheUrl: string,
    device: DLDevice,
    cacheScope = "tvmjs",
    cacheType = "cache",
    signal?: AbortSignal,
  ): Promise<any> {
    let artifactCache: ArtifactCacheTemplate;
    if (cacheType === undefined || cacheType.toLowerCase() === "cache") {
      artifactCache = new ArtifactCache(cacheScope);
    } else if (cacheType.toLowerCase() == "indexeddb") {
      artifactCache = new ArtifactIndexedDBCache(cacheScope);
    } else {
      console.error("Unsupported cacheType: " + cacheType + ", using default ArtifactCache.");
      artifactCache = new ArtifactCache(cacheScope);
    }
    const jsonUrl = new URL("ndarray-cache.json", ndarrayCacheUrl).href;
    const list = await artifactCache.fetchWithCache(jsonUrl, "json");
    await this.fetchNDArrayCacheInternal(
      ndarrayCacheUrl,
      list["records"] as Array<NDArrayShardEntry>, device, artifactCache,
      signal);
    this.cacheMetadata = { ...this.cacheMetadata, ...(list["metadata"] as Record<string, any>) };
  }


  /**
   * Fetch list of NDArray into the NDArrayCache.
   *
   * @param ndarrayCacheUrl The cache url.
   * @param list The list of array data.
   * @param device The device to store the data to.
   * @param artifactCache The artifact cache
   * @param signal An optional AbortSignal to abort the fetch
   */
  private async fetchNDArrayCacheInternal(
    ndarrayCacheUrl: string,
    list: Array<NDArrayShardEntry>,
    device: DLDevice,
    artifactCache: ArtifactCacheTemplate,
    signal?: AbortSignal,
  ) {
    const perf = compact.getPerformance();
    const tstart = perf.now();
    let totalBytes = 0;
    for (let i = 0; i < list.length; ++i) {
      totalBytes += list[i].nbytes;
    }
    let fetchedBytes = 0;
    let fetchedShards = 0;
    let timeElapsed = 0;

    const cacheOnly = await artifactCache.hasAllKeys(list.map(key => new URL(key.dataPath, ndarrayCacheUrl).href));

    // `loading`: we have finished downloading (or already cacheOnly) and are loading onto WebGPU
    const reportCallback = (iter: number, loading = false) => {
      // report
      for (let j = 0; j < this.initProgressCallback.length; ++j) {
        let text: string;
        if (loading) {
          text = "Loading model from cache[" + iter + "/" + list.length + "]: ";
          text += Math.ceil(fetchedBytes / (1024 * 1024)).toString() + "MB loaded. "
          text += Math.floor(fetchedBytes * 100 / totalBytes).toString() + "% completed, "
          text += timeElapsed + " secs elapsed.";
        } else {
          text = "Fetching param cache[" + iter + "/" + list.length + "]: ";
          text += Math.ceil(fetchedBytes / (1024 * 1024)).toString() + "MB fetched. "
          text += Math.floor(fetchedBytes * 100 / totalBytes).toString() + "% completed, "
          text += timeElapsed + " secs elapsed.";
          text += " It can take a while when we first visit this page to populate the cache."
          text += " Later refreshes will become faster.";
        }
        this.initProgressCallback[j]({
          progress: fetchedBytes / totalBytes,
          timeElapsed: timeElapsed,
          text: text
        });
      }
    };

    for (let j = 0; j < this.initProgressCallback.length; ++j) {
      this.initProgressCallback[j]({
        progress: fetchedBytes / totalBytes,
        timeElapsed: 0,
        text: "Start to fetch params",
      });
    }

    // First download all shards to cache parallely if not yet in cache
    const downloadCache = async (start: number, end: number) => {
      // Download params [start, end) from `list`
      for (let i = start; i < end; i++) {
        const shard = list[i];
        const dataUrl = new URL(shard.dataPath, ndarrayCacheUrl).href;
        try {
          await artifactCache.addToCache(dataUrl, "arraybuffer", signal);
        } catch (err) {
          this.env.logger("Error: Cannot fetch " + dataUrl + " err= " + err);
          throw err;
        }
        timeElapsed = Math.ceil((perf.now() - tstart) / 1000);
        fetchedBytes += shard.nbytes;
        reportCallback(fetchedShards++, /*loading=*/false);
      }
    }
    // We launch 4 parallel for loops to limit the max concurrency to 4 download
    if (!cacheOnly) {
      const loopSize = Math.floor(list.length / 4);
      await Promise.all([
        downloadCache(0, loopSize),
        downloadCache(loopSize, 2 * loopSize),
        downloadCache(2 * loopSize, 3 * loopSize),
        downloadCache(3 * loopSize, list.length)
      ]);
    }

    // Then iteratively, load the shard from cache
    for (let i = 0; i < list.length; ++i) {
      const shard = list[i];
      const dataUrl = new URL(shard.dataPath, ndarrayCacheUrl).href;
      let buffer;
      try {
        buffer = await artifactCache.fetchWithCache(dataUrl, "arraybuffer");
      } catch (err) {
        this.env.logger("Error: Cannot fetch " + dataUrl + " err= " + err);
        throw err;
      }
      const shardRecords = shard.records;
      for (let j = 0; j < shardRecords.length; ++j) {
        try {
          const rec = shardRecords[j];
          const cpu_arr = this.withNewScope(() => {
            return this.detachFromCurrentScope(
              this.empty(rec.shape, rec.dtype, this.cpu())
            )
          });
          const recSource = buffer.slice(rec.byteOffset, rec.byteOffset + rec.nbytes);
          // first sync copy to cpu.
          this.ctx.arrayDecodeStorage(cpu_arr, new Uint8Array(recSource), rec.format, rec.dtype);
          // then async stream into GPU if needed
          if (device.deviceType === DeviceStrToEnum.cpu) {
            this.ndarrayCacheUpdate(rec.name, cpu_arr, false);
            cpu_arr.dispose();
          } else {
            // allocate a gpu arr and async copy to it.
            const gpu_arr = this.withNewScope(() => {
              return this.detachFromCurrentScope(
                this.empty(rec.shape, rec.dtype, device)
              )
            });
            gpu_arr.copyFrom(cpu_arr);
            await device.sync();
            this.ndarrayCacheUpdate(rec.name, gpu_arr, false);
            cpu_arr.dispose();
            gpu_arr.dispose();
          }
        } catch (err) {
          this.env.logger(
            "Failed to load shard " + i + "'s record: " + JSON.stringify(shardRecords[j]) + "\n" +
            "Error: " + err
          );
          throw err;
        }
      }
      reportCallback(i + 1, /*loading=*/true);
    }
  }

  /**
   * Create a new {@link Scalar} that can be passed to a PackedFunc.
   * @param value The number value.
   * @param dtype The dtype string.
   * @returns The created scalar.
   */
  scalar(value: number, dtype: string): Scalar {
    return new Scalar(value, dtype);
  }

  /**
   * Create a new {@link DLDevice}
   * @param deviceType The device type.
   * @param deviceId The device index.
   * @returns The created device.
   */
  device(deviceType: number | string, deviceId = 0): DLDevice {
    return new DLDevice(deviceType, deviceId, this.lib);
  }

  /**
   * Create a new cpu {@link DLDevice}
   * @param deviceId The device index.
   */
  cpu(deviceId = 0): DLDevice {
    return this.device("cpu", deviceId);
  }

  /**
   * Create a new webgpu {@link DLDevice}
   * @param deviceId The device index.
   */
  webgpu(deviceId = 0): DLDevice {
    return this.device("webgpu", deviceId);
  }

  /**
   * Create an empty {@link NDArray} with given shape and dtype.
   *
   * @param shape The shape of the array.
   * @param dtype The data type of the array.
   * @param dev The device of the ndarray.
   * @returns The created ndarray.
   */
  empty(
    shape: Array<number> | number,
    dtype: string | DLDataType = "float32",
    dev: DLDevice = this.device("cpu", 0)
  ): NDArray {
    shape = typeof shape === "number" ? [shape] : shape;
    return this.ctx.ndarrayEmpty(this.makeShapeTuple(shape), dtype, dev, null);
  }

  /**
   * Create am uniform {@link NDArray} with given shape.
   *
   * @param shape The shape of the array.
   * @param low The low value.
   * @param high The high value.
   * @param dev The device of the ndarray.
   * @returns The created ndarray.
   */
  uniform(
    shape: Array<number>,
    low: number,
    high: number,
    dev: DLDevice
  ): NDArray {
    const ret = this.empty(shape, "float32", dev);
    const size = shape.reduce((a, b) => {
      return a * b;
    }, 1);
    const scale = high - low;
    const input = new Float32Array(size);
    for (let i = 0; i < input.length; ++i) {
      input[i] = low + this.rng.randomFloat() * scale;
    }
    return ret.copyFrom(input);
  }

  /**
   * Set the seed of the internal LinearCongruentialGenerator.
   */
  setSeed(seed: number): void {
    this.rng.setSeed(seed);
  }

  /**
   * Sample index via top-p sampling.
   *
   * @param logits The input logits before normalization.
   * @param temperature  The temperature factor, will take argmax if temperature = 0.0
   * @param top_p The top_p
   * @returns The sampled index.
   */
  sampleTopPFromLogits(logits: NDArray, temperature: number, top_p: number): number {
    return this.ctx.sampleTopPFromLogits(logits, temperature, top_p, this.rng.randomFloat());
  }

  /**
   * Sample index via top-p sampling.
   *
   * @param prob The distribution, i.e. logits after `applySoftmaxWithTemperature()` is performed.
   * @param top_p The top_p
   * @returns The sampled index.
   */
  sampleTopPFromProb(prob: NDArray, top_p: number): number {
    return this.ctx.sampleTopPFromProb(prob, top_p, this.rng.randomFloat());
  }

  /**
   * Apply repetition penalty to the logits.
   * @param logits The input logits before penalty.
   * @param token_ids The appeared token ids.
   * @param penalty The penalty factor.
   */
  applyRepetitionPenalty(logits: NDArray, token_ids: NDArray, penalty: number) {
    return this.ctx.applyRepetitionPenalty(logits, token_ids, penalty);
  }

  /**
   * Apply presence and frequency penalty. This is an inplace operation.
   * @param logits The input logits before penalty.
   * @param token_ids The appeared token ids.
   * @param token_freqs The number of times each token has appeared since last PrefillStep.
   * token_freqs[i] is the frequency of token_ids[i], for all i. And all token_freqs should be >= 1.
   * @param presence_penalty The penalty factor.
   * @param frequency_penalty The penalty factor.
   */
  applyPresenceAndFrequencyPenalty(
    logits: NDArray,
    token_ids: NDArray,
    token_freqs: NDArray,
    presence_penalty: number,
    frequency_penalty: number
  ) {
    return this.ctx.applyPresenceAndFrequencyPenalty(
      logits, token_ids, token_freqs, presence_penalty, frequency_penalty
    );
  }

  /**
   * Apply softmax with temperature to the logits.
   * @param logits The input logits before softmax w/ temperature.
   * @param temperature The temperature factor.
   */
  applySoftmaxWithTemperature(logits: NDArray, temperature: number) {
    return this.ctx.applySoftmaxWithTemperature(logits, temperature);
  }

  /**
   * Bind canvas to the current WebGPU context
   * @param canvas The canvas.
   */
  bindCanvas(canvas: HTMLCanvasElement) {
    this.lib.webGPUContext?.bindCanvas(canvas);
  }

  /**
   * Show image in canvas.
   *
   * @param dataRGBA Image array in height x width uint32 NDArray RGBA format on GPU.
   */
  showImage(dataRGBA: NDArray) {
    if (dataRGBA.shape.length != 2) {
      throw Error("Require a height x width uint32 NDArray in RGBA" +
        "get shape=" + dataRGBA.shape.toString() + " instead."
      );
    }
    if (dataRGBA.device.deviceType != DeviceStrToEnum.webgpu) {
      throw new Error("Can only run showImage on WebGPU array, " +
        "get " + DeviceEnumToStr[dataRGBA.device.deviceType] + " instead.");
    }
    if (dataRGBA.dtype != "uint32") {
      throw Error("Require a height x width uint32 NDArray in RGBA, " +
        "get " + dataRGBA.dtype + " instead.");
    }
    this.lib.webGPUContext?.drawImageFromBuffer(
      dataRGBA.getDataPtr(), dataRGBA.shape[0], dataRGBA.shape[1]
    );
  }

  /**
   * Clear canvas
   */
  clearCanvas() {
    this.lib.webGPUContext?.clearCanvas();
  }

  /**
   * Create an tuple {@link TVMArray} input array.
   *
   * The input array can be passed to tvm runtime function
   * and needs to b explicitly disposed.
   *
   * @param inputs The input array
   * @returns The result array.
   */
  makeTVMArray(
    inputs: Array<any>
  ): TVMArray {
    const CALL_STACK_LIMIT = 30000;
    const inputsLength = inputs.length;
    if (inputsLength <= CALL_STACK_LIMIT) {
      return this.ctx.arrayMake(...inputs) as TVMArray;
    }
    // If too many elements, TypeScript would complain `Maximum call stack size exceeded`
    // So we make several arrays and concatenate them
    const listOfArrays: Array<TVMArray> = [];
    for (let begin = 0; begin < inputsLength; begin += CALL_STACK_LIMIT) {
      const end = Math.min(inputsLength, begin + CALL_STACK_LIMIT);
      const chunk: Array<any> = inputs.slice(begin, end);
      listOfArrays.push(this.ctx.arrayMake(...chunk) as TVMArray);
    }
    return this.ctx.arrayConcat(...listOfArrays) as TVMArray;
  }

  /**
   * Join a sequence of NDArrays that represent embeddings.
   * @param inputs A list of embeddings in NDArrays, each array i has shape (m_i, hidden_size).
   * @returns An NDArray of shape (\sum_{i} {m}, hidden_size)
   */
  concatEmbeddings(embeddings: Array<NDArray>): NDArray {
    // 1. Check shape validity
    const hidden_size = embeddings[0].shape[1];
    embeddings.forEach((input) => {
      if (input.shape.length !== 2 || input.shape[1] !== hidden_size) {
        throw new Error("Expect embeddings to concatenate have shape (m_i, hidden_size).");
      }
    })

    // 2. Call global func
    if (this.ctx.concatEmbeddings === undefined) {
      throw new Error(
        "Global function tvmjs.runtime.ConcatEmbeddings was " +
        "not found, but called concatEmbeddings."
      );
    }
    return this.ctx.concatEmbeddings(...embeddings) as NDArray;
  }

  /**
   * Create a shape tuple to pass to runtime.
   * @param shape The shape .
   * @returns The created shape tuple.
   */
  makeShapeTuple(shape: Array<number>): TVMObject {
    const shapeArray = shape.map((value) => new Scalar(value, "int"));
    return this.ctx.makeShapeTuple(...shapeArray);
  }
  /**
   * Get type index from type key.
   * @param typeKey The type key.
   * @returns The corresponding type index.
   */
  typeKey2Index(
    typeKey: string
  ): number {
    const stack = this.lib.getOrAllocCallStack();
    const typeKeyOffset = stack.allocByteArrayForString(typeKey);
    const outOffset = stack.allocPtrArray(1);
    const outPtr = stack.ptrFromOffset(outOffset);

    stack.commitToWasmMemory(outOffset);
    this.lib.checkCall(
      (this.lib.exports.TVMFFITypeKeyToIndex as ctypes.FTVMFFITypeKeyToIndex)(
        stack.ptrFromOffset(typeKeyOffset),
        outPtr
      )
    );
    const typeIndex = this.memory.loadU32(outPtr);
    this.lib.recycleCallStack(stack);
    return typeIndex;
  }

  /**
   * Register an object constructor.
   * @param typeKey The name of the function.
   * @param func Function to be registered.
   * @param override Whether overwrite function in existing registry.
   */
  registerObjectConstructor(
    typeKey: string,
    func: FObjectConstructor,
    override = false
  ): void {
    const typeIndex = this.typeKey2Index(typeKey);
    if (this.objFactory.has(typeIndex)) {
      if (!override) {
        throw new Error("Type " + typeKey + " already registered");
      }
    }
    this.objFactory.set(typeIndex, func);
  }

  /**
   * Wrap a function obtained from tvm runtime as AsyncPackedFunc
   * through the asyncify mechanism
   *
   * You only need to call it if the function may contain callback into async
   * JS function via asynctify. A common one can be GPU synchronize.
   *
   * It is always safe to wrap any function as Asynctify, however you do need
   * to make sure you use await when calling the funciton.
   *
   * @param func The PackedFunc.
   * @returns The wrapped AsyncPackedFunc
   */
  wrapAsyncifyPackedFunc(func: PackedFunc): AsyncPackedFunc {
    const asyncFunc = this.asyncifyHandler.wrapExport(func) as AsyncPackedFunc;
    asyncFunc.dispose = func.dispose;
    asyncFunc._tvmPackedCell = func._tvmPackedCell;
    return asyncFunc;
  }

  /**
   * Register async function as asynctify callable in global environment.
   *
   * @param name The name of the function.
   * @param func function to be registered.
   * @param override Whether overwrite function in existing registry.
   *
   * @note This function is handled via asynctify mechanism
   * The wasm needs to be compiled with Asynctify
   */
  registerAsyncifyFunc(
    name: string,
    func: (...args: Array<any>) => Promise<any>,
    override = false
  ): void {
    const asyncWrapped = this.asyncifyHandler.wrapImport(func);
    this.registerFunc(name, asyncWrapped, override);
  }

  /**
   * Register an asyncfunction to be global function in the server.
   *
   * @param name The name of the function.
   * @param func function to be registered.
   * @param override Whether overwrite function in existing registry.
   *
   * @note The async function will only be used for serving remote calls in the rpc
   * These functions contains explicit continuation
   */
  registerAsyncServerFunc(
    name: string,
    func: Function,
    override = false
  ): void {
    const asyncVariant = (...args: Array<any>): void => {
      const fargs = args.slice(0, args.length - 1);
      // need to keep it alive until callback is fulfilled.
      const callback = this.detachFromCurrentScope(args[args.length - 1] as PackedFunc);
      const promise: Promise<any> = func(...fargs);
      const onFulfilled = (rv: any) => {
        callback(this.scalar(AsyncCallbackCode.kReturn, "int32"), rv);
        callback.dispose();
      };
      const onRejected = (reason: any) => {
        callback(this.scalar(AsyncCallbackCode.kException, "int32"), reason.toString());
        callback.dispose();
      };
      promise.then(onFulfilled, onRejected);
    };
    this.registerFunc("__async." + name, asyncVariant, override);
  }

  /**
   * Asynchronously load webgpu pipelines when possible.
   * @param mod The input module.
   */
  async asyncLoadWebGPUPipelines(mod: Module): Promise<void> {
    if (this.lib.webGPUContext === undefined) throw Error("WebGPU not initialied");
    const webgpuContext = this.lib.webGPUContext;

    this.beginScope();
    const fmap_str = mod.getFunction("webgpu.get_fmap", true)() as string;
    const fmap: Record<string, FunctionInfo> = JSON.parse(fmap_str);
    const fGetShader = this.detachFromCurrentScope(
      mod.getFunction("webgpu.get_shader")
    );
    const fUpdatePrebuild = this.detachFromCurrentScope(
      mod.getFunction("webgpu.update_prebuild")
    );
    this.endScope();

    const perf = compact.getPerformance();
    const tstart = perf.now();
    let tlastReport = tstart;
    let finishCounter = 0;
    const fmapEntries = Object.entries(fmap);

    let allEvents = Promise.resolve();

    for (const [key, finfo] of fmapEntries) {
      const code = fGetShader(key);
      assert(key === finfo.name);
      const event = webgpuContext.createShaderAsync(finfo, code).then((func) => {
        this.beginScope();
        fUpdatePrebuild(key, func);
        this.endScope();

      }).then(() => {
        finishCounter += 1;
        const tend = perf.now();
        // skip report if gap is smaller than 1000
        if ((tend - tlastReport) < 1000 && finishCounter != fmapEntries.length) {
          return;
        }
        tlastReport = tend;
        const timeElapsed = Math.ceil((perf.now() - tstart) / 1000);
        // report
        for (let j = 0; j < this.initProgressCallback.length; ++j) {
          const progress = finishCounter / fmapEntries.length;
          let text = "Loading GPU shader modules[" + finishCounter + "/" + fmapEntries.length + "]: ";
          text += Math.floor(progress * 100).toString() + "% completed, "
          text += timeElapsed + " secs elapsed.";
          this.initProgressCallback[j]({
            progress: progress,
            timeElapsed: timeElapsed,
            text: text
          });
        }
      });
      allEvents = Promise.all([allEvents, event]).then(() => { });
    }
    await allEvents;
    assert(finishCounter === fmapEntries.length);
  }

  /**
   * Initialize webgpu in the runtime.
   * @param device The given GPU device.
   */
  initWebGPU(device: GPUDevice): void {
    device.addEventListener("uncapturederror", (event) => {
      console.error("A WebGPU error was not captured: ", event);
    });

    device.lost.then((info: any) => {
      if (this.deviceLostIsError) {
        console.error("Device lost, calling Instance.dispose(). Please initialize again. ", info);
        this.dispose();
      }
    });
    this.deviceLostIsError = true;

    const webGPUContext = new WebGPUContext(
      this.memory, device
    );
    this.registerFunc("wasm.WebGPUDeviceAPI", (name: string) => {
      return webGPUContext.getDeviceAPI(name);
    });
    this.registerFunc("wasm.WebGPUCreateShader", (info: string, code: string) => {
      const finfo = JSON.parse(info) as FunctionInfo;
      return webGPUContext.createShader(finfo, code);
    });
    this.registerAsyncServerFunc("wasm.WebGPUWaitForTasks", async () => {
      await webGPUContext.sync();
    });
    if (this.asyncifyHandler.enabled()) {
      this.registerAsyncifyFunc("__asyncify.WebGPUWaitForTasks", async () => {
        await webGPUContext.sync();
      });
    }
    this.lib.webGPUContext = webGPUContext;
  }

  /** Register all object factory */
  private registerObjectFactoryFuncs(): void {
    this.registerObjectConstructor("ffi.Array",
      (handle: number, lib: FFILibrary, ctx: RuntimeContext) => {
        return new TVMArray(handle, lib, ctx);
      });
    this.registerObjectConstructor("runtime.Module",
      (handle: number, lib: FFILibrary, ctx: RuntimeContext) => {
        return new Module(handle, lib, ctx);
      });
  }

  /** Register global packed functions needed by the backend to the env. */
  private registerEnvGlobalPackedFuncs(): void {
    // Register the timer function to enable the time_evaluator.
    const perf = compact.getPerformance();

    // Helper function to time the finvoke
    const timeExecution = async (
      finvoke: PackedFunc,
      dev: DLDevice,
      nstep: number,
      repeat: number,
      minRepeatMs: number,
      limitZeroTimeIterations: number,
      cooldownIntervalMs: number,
      repeatsToCooldown: number
    ): Promise<Uint8Array> => {
      // detach and explicit dispose when tasks is fullfilled
      // the promise will immediately return and we need to makesure
      // finvoke do not get recycled.
      this.ctx.detachFromCurrentScope(finvoke);

      finvoke(this.scalar(1, "int32"));
      await dev.sync();
      const result = [];
      let setupNumber: number = nstep;

      for (let i = 0; i < repeat; ++i) {
        let durationMs = 0.0;
        let absoluteZeroTimes = 0;
        do {
          if (durationMs > 0.0) {
            const golden_ratio = 1.618;
            setupNumber = Math.floor(
              Math.max(minRepeatMs / (durationMs / setupNumber) + 1, setupNumber * golden_ratio)
            );
          }
          const tstart: number = perf.now();
          finvoke(this.scalar(setupNumber, "int32"));
          await dev.sync();
          const tend: number = perf.now();

          durationMs = tend - tstart;
          if (durationMs === 0) {
            absoluteZeroTimes++;
          }
        } while (durationMs < minRepeatMs && absoluteZeroTimes < limitZeroTimeIterations);
        const speed = durationMs / setupNumber / 1000;
        result.push(speed);
        if (cooldownIntervalMs > 0.0 && (i % repeatsToCooldown) === 0) {
          await new Promise(r => setTimeout(r, cooldownIntervalMs));
        }
      }
      const ret = new Float64Array(result.length);
      ret.set(result);

      // dispose finvoke
      finvoke.dispose();
      return new Uint8Array(ret.buffer);
    };

    const addOne = async (x: number): Promise<number> => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return x + 1;
    };

    this.registerAsyncServerFunc("wasm.TimeExecution", timeExecution);
    this.registerAsyncServerFunc("testing.asyncAddOne", addOne);
  }

  private createPackedFuncFromSafeCallType(
    func: ctypes.FTVMFFIWasmSafeCallType
  ): PackedFunc {
    let findex = this.env.packedCFuncTable.length;
    if (this.env.packedCFuncTableFreeId.length != 0) {
      findex = this.env.packedCFuncTableFreeId.pop() as number;
    } else {
      this.env.packedCFuncTable.push(undefined);
    }
    this.env.packedCFuncTable[findex] = func;

    const stack = this.lib.getOrAllocCallStack();
    const outOffset = stack.allocPtrArray(1);
    const outPtr = stack.ptrFromOffset(outOffset);
    this.lib.checkCall(
      (this.exports
        .TVMFFIWasmFunctionCreate as ctypes.FTVMFFIWasmFunctionCreate)(
          findex,
          outPtr
        )
    );
    const ret = this.makePackedFunc(this.memory.loadPointer(outPtr));
    this.lib.recycleCallStack(stack);
    return ret;
  }

  /**
   * Set packed function arguments into the location indicated by argsValue and argsCode.
   * Allocate new temporary space from the stack if necessary.
   *
   * @parma stack The call stack
   * @param args  The input arguments.
   * @param packedArgs The offset of packedArgs.
   */
  setPackedArguments(
    stack: CachedCallStack,
    args: Array<any>,
    packedArgs: PtrOffset,
  ): void {
    for (let i = 0; i < args.length; ++i) {
      let val = args[i];
      const tp = typeof val;
      const argOffset = packedArgs + i * SizeOf.TVMFFIAny;
      const argTypeIndexOffset = argOffset;
      const argValueOffset = argOffset + SizeOf.I32 * 2;

      // Convert string[] to a TVMArray of, hence treated as a TVMObject
      if (val instanceof Array && val.every(e => typeof e === "string")) {
        const tvmStringArray: string[] = [];
        val.forEach(e => { tvmStringArray.push(e) });
        val = this.makeTVMArray(tvmStringArray);
      }

      // clear off the extra padding valuesbefore ptr storage
      stack.storeI32(argTypeIndexOffset + SizeOf.I32, 0);
      stack.storeI32(argValueOffset + SizeOf.I32, 0);
      if (val instanceof NDArray) {
        if (!val.isView) {
          stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFINDArray);
          stack.storePtr(argValueOffset, val.getHandle());
        } else {
          stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIDLTensorPtr);
          stack.storePtr(argValueOffset, val.getHandle());
        }
      } else if (val instanceof Scalar) {
        if (val.dtype.startsWith("int") || val.dtype.startsWith("uint")) {
          stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIInt);
          stack.storeI64(argValueOffset, val.value);
        } else if (val.dtype.startsWith("float")) {
          stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIFloat);
          stack.storeF64(argValueOffset, val.value);
        } else {
          assert(val.dtype === "handle", "Expect handle");
          stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIOpaquePtr);
          stack.storePtr(argValueOffset, val.value);
        }
      } else if (val instanceof DLDevice) {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIDevice);
        stack.storeI32(argValueOffset, val.deviceType);
        stack.storeI32(argValueOffset + SizeOf.I32, val.deviceId);
      } else if (tp === "boolean") {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIBool);
        stack.storeI64(argValueOffset, val ? 1 : 0);
      } else if (tp === "number") {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIFloat);
        stack.storeF64(argValueOffset, val);
        // eslint-disable-next-line no-prototype-builtins
      } else if (tp === "function" && val.hasOwnProperty("_tvmPackedCell")) {
        stack.storePtr(argValueOffset, val._tvmPackedCell.getHandle());
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIFunction);
      } else if (val === null || val === undefined) {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFINone);
        stack.storePtr(argValueOffset, 0);
      } else if (tp === "string") {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIRawStr);
        stack.allocThenSetArgString(argValueOffset, val);
      } else if (val instanceof Uint8Array) {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIByteArrayPtr);
        stack.allocThenSetArgBytes(argValueOffset, val);
      } else if (val instanceof Function) {
        val = this.toPackedFuncInternal(val, false);
        stack.tempArgs.push(val);
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIFunction);
        stack.storePtr(argValueOffset, val._tvmPackedCell.getHandle());
      } else if (val instanceof Module) {
        stack.storeI32(argTypeIndexOffset, TypeIndex.kTVMFFIModule);
        stack.storePtr(argValueOffset, val.getHandle());
      } else if (val instanceof TVMObject) {
        stack.storeI32(argTypeIndexOffset, val.typeIndex());
        stack.storePtr(argValueOffset, val.getHandle());
      } else {
        throw new Error("Unsupported argument type " + tp + " value=`" + val.toString() + "`");
      }
    }
  }

  private wrapJSFuncAsSafeCallType(func: Function): ctypes.FTVMFFIWasmSafeCallType {
    const lib = this.lib;
    return (
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      self: Pointer,
      packedArgs: Pointer,
      numArgs: number,
      ret: Pointer
    ): number => {
      const jsArgs = [];
      // use scope to track js values.
      this.ctx.beginScope();
      for (let i = 0; i < numArgs; ++i) {
        const argPtr = packedArgs + i * SizeOf.TVMFFIAny;
        const typeIndex = lib.memory.loadI32(argPtr);

        if (typeIndex >= TypeIndex.kTVMFFIRawStr) {
          // NOTE: the following code have limitations in asyncify mode.
          // The reason is that the TVMFFIAnyViewToOwnedAny will simply
          // get skipped during the rewinding process, causing memory failure
          if (!this.asyncifyHandler.isNormalStackState()) {
            throw Error("Cannot handle str/object argument callback in asyncify mode");
          }
          lib.checkCall(
            (lib.exports.TVMFFIAnyViewToOwnedAny as ctypes.FTVMFFIAnyViewToOwnedAny)(
              argPtr,
              argPtr
            )
          );
        }
        jsArgs.push(this.retValueToJS(argPtr, true));
      }

      let rv: any;
      try {
        rv = func(...jsArgs);
      } catch (error) {
        // error handling
        // store error via SetLastError
        this.ctx.endScope();
        const errKind = "JSCallbackError"
        const errMsg = error.message;
        const stack = lib.getOrAllocCallStack();
        const errKindOffset = stack.allocRawBytes(errKind.length + 1);
        stack.storeRawBytes(errKindOffset, StringToUint8Array(errKind));
        const errMsgOffset = stack.allocRawBytes(errMsg.length + 1);
        stack.storeRawBytes(errMsgOffset, StringToUint8Array(errMsg));
        stack.commitToWasmMemory();
        (this.lib.exports.FTVMFFIErrorSetRaisedFromCStr as ctypes.FTVMFFIErrorSetRaisedFromCStr)(
          stack.ptrFromOffset(errKindOffset),
          stack.ptrFromOffset(errMsgOffset)
        );
        this.lib.recycleCallStack(stack);
        return -1;
      }

      // normal return path
      // recycle all js object value in function unless we want to retain them.
      this.ctx.endScope();
      if (rv !== undefined && rv !== null) {
        const stack = lib.getOrAllocCallStack();
        const argOffset = stack.allocRawBytes(SizeOf.TVMFFIAny);
        this.setPackedArguments(stack, [rv], argOffset);
        stack.commitToWasmMemory();
        const argPtr = stack.ptrFromOffset(argOffset);
        lib.checkCall(
          (lib.exports.TVMFFIAnyViewToOwnedAny as ctypes.FTVMFFIAnyViewToOwnedAny)(
            argPtr,
            ret
          )
        );
        lib.recycleCallStack(stack);
      }
      return 0;
    };
  }

  private makePackedFunc(handle: Pointer): PackedFunc {
    const cell = new PackedFuncCell(handle, this.lib, this.ctx);
    const packedFunc = (...args: any): any => {
      const stack = this.lib.getOrAllocCallStack();
      const argsOffset = stack.allocRawBytes(SizeOf.TVMFFIAny * args.length);
      this.setPackedArguments(stack, args, argsOffset);
      const retOffset = stack.allocRawBytes(SizeOf.TVMFFIAny);
      // pre-store the result to be null
      stack.storeI32(retOffset, TypeIndex.kTVMFFINone);
      stack.commitToWasmMemory();
      this.lib.checkCall(
        (this.exports.TVMFFIFunctionCall as ctypes.FTVMFFIFunctionCall)(
          cell.getHandle(),
          stack.ptrFromOffset(argsOffset),
          args.length,
          stack.ptrFromOffset(retOffset)
        )
      );

      const ret = this.retValueToJS(stack.ptrFromOffset(retOffset), false);
      this.lib.recycleCallStack(stack);
      return ret;
    };
    // Attach attributes to the function type.
    // This is because javascript do not allow us to overload call.
    const ret: any = packedFunc;
    ret.dispose = (): void => {
      cell.dispose();
    };
    ret._tvmPackedCell = cell;
    return ret as PackedFunc;
  }

  /**
   * Creaye return value of the packed func. The value us auto-tracked for dispose.
   * @param resultAnyPtr The location of rvalue
   * @param callbackArg Whether it is being used in callbackArg.
   * @returns The JS value.
   */
  private retValueToJS(resultAnyPtr: Pointer, callbackArg: boolean): any {
    const typeIndex = this.memory.loadI32(resultAnyPtr);
    const valuePtr = resultAnyPtr + SizeOf.I32 * 2;
    switch (typeIndex) {
      case TypeIndex.kTVMFFINone: return undefined;
      case TypeIndex.kTVMFFIBool:
        return this.memory.loadI64(valuePtr) != 0;
      case TypeIndex.kTVMFFIInt:
        return this.memory.loadI64(valuePtr);
      case TypeIndex.kTVMFFIFloat:
        return this.memory.loadF64(valuePtr);
      case TypeIndex.kTVMFFIOpaquePtr: {
        return this.memory.loadPointer(valuePtr);
      }
      case TypeIndex.kTVMFFINDArray: {
        return this.ctx.attachToCurrentScope(
          new NDArray(this.memory.loadPointer(valuePtr), this.lib, this.ctx, false)
        );
      }
      case TypeIndex.kTVMFFIDLTensorPtr: {
        assert(callbackArg);
        // no need to attach as we are only looking at view
        return new NDArray(this.memory.loadPointer(valuePtr), this.lib, this.ctx, true);
      }
      case TypeIndex.kTVMFFIFunction: {
        return this.ctx.attachToCurrentScope(
          this.makePackedFunc(this.memory.loadPointer(valuePtr))
        );
      }
      case TypeIndex.kTVMFFIDevice: {
        const deviceType = this.memory.loadI32(valuePtr);
        const deviceId = this.memory.loadI32(valuePtr + SizeOf.I32);
        return this.device(deviceType, deviceId);
      }
      case TypeIndex.kTVMFFIDataType: {
        // simply return dtype as tring to keep things simple
        this.lib.checkCall(
          (this.lib.exports.TVMFFIDataTypeToString as ctypes.FTVMFFIDataTypeToString)(valuePtr, valuePtr)
        );
        const strObjPtr = this.memory.loadPointer(valuePtr);
        const result = this.memory.loadByteArrayAsString(strObjPtr + SizeOf.ObjectHeader);
        this.lib.checkCall(
          (this.lib.exports.TVMFFIObjectFree as ctypes.FTVMFFIObjectFree)(strObjPtr)
        );
        return result;
      }
      case TypeIndex.kTVMFFIStr: {
        const strObjPtr = this.memory.loadPointer(valuePtr);
        const result = this.memory.loadByteArrayAsString(strObjPtr + SizeOf.ObjectHeader);
        this.lib.checkCall(
          (this.lib.exports.TVMFFIObjectFree as ctypes.FTVMFFIObjectFree)(strObjPtr)
        );
        return result;
      }
      case TypeIndex.kTVMFFIBytes: {
        const bytesObjPtr = this.memory.loadPointer(valuePtr);
        const result = this.memory.loadByteArrayAsBytes(bytesObjPtr + SizeOf.ObjectHeader);
        this.lib.checkCall(
          (this.lib.exports.TVMFFIObjectFree as ctypes.FTVMFFIObjectFree)(bytesObjPtr)
        );
        return result;
      }
      default: {
        if (typeIndex >= TypeIndex.kTVMFFIStaticObjectBegin) {
          const obj = new TVMObject(
            this.memory.loadPointer(valuePtr),
            this.lib,
            this.ctx
          );
          const func = this.objFactory.get(obj.typeIndex())
          if (func != undefined) {
            return this.ctx.attachToCurrentScope(
              func(obj.getHandle(), this.lib, this.ctx)
            );
          } else {
            return this.ctx.attachToCurrentScope(obj);
          }
        } else {
          throw new Error("Unsupported return type code=" + typeIndex);
        }
      }
    }
  }
}

/**
 * Asynchrously instantiate a new {@link Instance}.
 *
 * importObject can also be a {@link LibraryProvider} object,
 * a WASI object, or an object containing wasmLibraryProvider field.
 * We can take benefit of syslib implementations from the Emscripten
 * by passing its generated js Module as the imports.
 *
 * @param bufferSource The source to be compiled.
 * @param importObject The import objects.
 * @param logger The system logger.
 */
export function instantiate(
  bufferSource: ArrayBuffer,
  importObject: Record<string, any> = {},
  logger: (msg: string) => void = console.log
): Promise<Instance> {
  const env = new Environment(importObject, logger);

  return WebAssembly.instantiate(bufferSource, env.imports).then(
    (result: WebAssembly.WebAssemblyInstantiatedSource): Instance => {
      return new Instance(result.module, {}, result.instance, env);
    }
  );
}
