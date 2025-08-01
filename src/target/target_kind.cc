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

/*!
 * \file src/target/target_kind.cc
 * \brief Target kind registry
 */
#include <tvm/ffi/function.h>
#include <tvm/ffi/reflection/registry.h>
#include <tvm/ir/expr.h>
#include <tvm/runtime/device_api.h>
#include <tvm/target/target.h>
#include <tvm/target/target_kind.h>

#include <algorithm>

#include "../node/attr_registry.h"
#include "../support/utils.h"
#include "./parsers/cpu.h"

namespace tvm {

TVM_FFI_STATIC_INIT_BLOCK({ TargetKindNode::RegisterReflection(); });

// helper to get internal dev function in objectref.
struct TargetKind2ObjectPtr : public ObjectRef {
  static ObjectPtr<Object> Get(const TargetKind& kind) {
    return ffi::details::ObjectUnsafe::ObjectPtrFromObjectRef<Object>(kind);
  }
};

TVM_REGISTER_NODE_TYPE(TargetKindNode)
    .set_creator([](const std::string& name) {
      auto kind = TargetKind::Get(name);
      ICHECK(kind.defined()) << "Cannot find target kind \'" << name << '\'';
      return TargetKind2ObjectPtr::Get(kind.value());
    })
    .set_repr_bytes([](const Object* n) -> std::string {
      return static_cast<const TargetKindNode*>(n)->name;
    });

TVM_STATIC_IR_FUNCTOR(ReprPrinter, vtable)
    .set_dispatch<TargetKindNode>([](const ObjectRef& obj, ReprPrinter* p) {
      const TargetKind& kind = Downcast<TargetKind>(obj);
      p->stream << kind->name;
    });

/**********  Registry-related code  **********/

using TargetKindRegistry = AttrRegistry<TargetKindRegEntry, TargetKind>;

Array<String> TargetKindRegEntry::ListTargetKinds() {
  return TargetKindRegistry::Global()->ListAllNames();
}

Map<String, String> TargetKindRegEntry::ListTargetKindOptions(const TargetKind& target_kind) {
  Map<String, String> options;
  for (const auto& kv : target_kind->key2vtype_) {
    options.Set(kv.first, kv.second.type_key);
  }
  return options;
}

TargetKindRegEntry& TargetKindRegEntry::RegisterOrGet(const String& target_kind_name) {
  return TargetKindRegistry::Global()->RegisterOrGet(target_kind_name);
}

void TargetKindRegEntry::UpdateAttr(const String& key, ffi::Any value, int plevel) {
  TargetKindRegistry::Global()->UpdateAttr(key, kind_, value, plevel);
}

const AttrRegistryMapContainerMap<TargetKind>& TargetKind::GetAttrMapContainer(
    const String& attr_name) {
  return TargetKindRegistry::Global()->GetAttrMap(attr_name);
}

Optional<TargetKind> TargetKind::Get(const String& target_kind_name) {
  const TargetKindRegEntry* reg = TargetKindRegistry::Global()->Get(target_kind_name);
  if (reg == nullptr) {
    return std::nullopt;
  }
  return reg->kind_;
}

/**********  Utility functions  **********/

/*!
 * \brief Extract a string from the string with the given prefix.
 * For example, when `str` is "sm_20" and `prefix` is "sm_".
 * This function first checks if `str` starts with `prefix`,
 * then return the integer 20 after the `prefix`
 * \param str The string to be extracted
 * \param prefix The prefix to be checked
 * \return A string, the extracted string. "" if the check fails
 */
std::string ExtractStringWithPrefix(const std::string& str, const std::string& prefix) {
  if (str.find(prefix) != 0) return "";
  std::size_t pos = prefix.length();
  while (pos < str.length() && (std::isdigit(str[pos]) || std::isalpha(str[pos]))) {
    ++pos;
  }
  return str.substr(prefix.length(), pos - prefix.length());
}

/*!
 * \brief Using TVM DeviceAPI to detect the device flag
 * \param device The device to be detected
 * \param flag The device flag to be detected
 * \param val The detected value
 * \return A boolean indicating if detection succeeds
 */
static bool DetectDeviceFlag(Device device, runtime::DeviceAttrKind flag, ffi::Any* val) {
  using runtime::DeviceAPI;
  DeviceAPI* api = DeviceAPI::Get(device, true);
  // Check if compiled with the corresponding device api
  if (api == nullptr) {
    return false;
  }
  // Check if the device exists
  api->GetAttr(device, runtime::kExist, val);
  int exists = val->cast<int>();
  if (!exists) {
    return false;
  }
  // Get the arch of the device
  DeviceAPI::Get(device)->GetAttr(device, flag, val);
  return true;
}

void CheckOrSetAttr(Map<String, ffi::Any>* attrs, const String& name, const String& value) {
  auto iter = attrs->find(name);
  if (iter == attrs->end()) {
    attrs->Set(name, value);
  } else {
    auto str = (*iter).second.try_cast<String>();
    ICHECK(str && str.value() == value) << "ValueError: Expects \"" << name << "\" to be \""
                                        << value << "\", but gets: " << (*iter).second;
  }
}

/**********  Target kind attribute updaters  **********/

/*!
 * \brief Update the attributes in the CUDA target.
 * \param target The Target to update
 * \return The updated attributes
 */
TargetJSON UpdateCUDAAttrs(TargetJSON target) {
  // Update -arch=sm_xx
  if (target.count("arch")) {
    // If -arch has been specified, validate the correctness
    String archStr = Downcast<String>(target.at("arch"));
    ICHECK(support::StartsWith(archStr, "sm_"))
        << "ValueError: CUDA target gets an invalid CUDA arch: -arch=" << archStr;
  } else {
    // Use the compute version of the first CUDA GPU instead
    int archInt;
    ffi::Any version;
    if (!DetectDeviceFlag({kDLCUDA, 0}, runtime::kComputeVersion, &version)) {
      LOG(WARNING) << "Unable to detect CUDA version, default to \"-arch=sm_50\" instead";
      archInt = 50;
    } else {
      archInt = std::stod(version.cast<std::string>()) * 10 + 0.1;
    }
    target.Set("arch", String("sm_") + std::to_string(archInt));
  }
  return target;
}

/*!
 * \brief Update the attributes in the LLVM NVPTX target.
 * \param target The Target to update
 * \return The updated attributes
 */
TargetJSON UpdateNVPTXAttrs(TargetJSON target) {
  CheckOrSetAttr(&target, "mtriple", "nvptx64-nvidia-cuda");
  // Update -mcpu=sm_xx
  if (target.count("mcpu")) {
    // If -mcpu has been specified, validate the correctness
    String mcpu = Downcast<String>(target.at("mcpu"));
    ICHECK(support::StartsWith(mcpu, "sm_"))
        << "ValueError: NVPTX target gets an invalid CUDA arch: -mcpu=" << mcpu;
  } else {
    // Use the compute version of the first CUDA GPU instead
    int arch;
    ffi::Any version;
    if (!DetectDeviceFlag({kDLCUDA, 0}, runtime::kComputeVersion, &version)) {
      LOG(WARNING) << "Unable to detect CUDA version, default to \"-mcpu=sm_50\" instead";
      arch = 50;
    } else {
      arch = std::stod(version.cast<std::string>()) * 10 + 0.1;
    }
    target.Set("mcpu", String("sm_") + std::to_string(arch));
  }
  return target;
}

/*!
 * \brief Update the attributes in the LLVM ROCm target.
 * \param target The Target to update
 * \return The updated attributes
 */
TargetJSON UpdateROCmAttrs(TargetJSON target) {
  CheckOrSetAttr(&target, "mtriple", "amdgcn-amd-amdhsa-hcc");
  // Update -mcpu=gfx
  std::string arch = "gfx900";
  if (target.count("mcpu")) {
    String mcpu = Downcast<String>(target.at("mcpu"));
    arch = ExtractStringWithPrefix(mcpu, "gfx");
    ICHECK(!arch.empty()) << "ValueError: ROCm target gets an invalid GFX version: -mcpu=" << mcpu;
  } else {
    ffi::Any val;
    if (const auto f_get_rocm_arch = tvm::ffi::Function::GetGlobal("tvm_callback_rocm_get_arch")) {
      arch = (*f_get_rocm_arch)().cast<std::string>();
    }
    target.Set("mcpu", String(arch));
  }
  // Update -mattr before ROCm 3.5:
  //   Before ROCm 3.5 we needed code object v2, starting
  //   with 3.5 we need v3 (this argument disables v3)

  ffi::Any val;
  int version;
  if (!DetectDeviceFlag({kDLROCM, 0}, runtime::kApiVersion, &val)) {
    LOG(WARNING) << "Unable to detect ROCm version, assuming >= 3.5";
    version = 305;
  } else {
    version = val.cast<int>();
  }
  if (version < 305) {
    Array<String> mattr;
    if (target.count("mattr")) {
      mattr = Downcast<Array<String>>(target.at("mattr"));
    }
    mattr.push_back("-code-object-v3");
    target.Set("mattr", mattr);
  }
  return target;
}

/*!
 * \brief Test Target Parser
 * \param target The Target to update
 * \return The updated attributes
 */
TargetJSON TestTargetParser(TargetJSON target) {
  Map<String, ffi::Any> features = {{"is_test", true}};
  target.Set("features", features);
  return target;
}

/**********  Register Target kinds and attributes  **********/

TVM_REGISTER_TARGET_KIND("llvm", kDLCPU)
    .add_attr_option<Array<String>>("mattr")
    .add_attr_option<String>("mcpu")
    .add_attr_option<String>("mtriple")
    .add_attr_option<String>("mfloat-abi")
    .add_attr_option<String>("mabi")
    .add_attr_option<int64_t>("num-cores")
    // Fast math flags, see https://llvm.org/docs/LangRef.html#fast-math-flags
    .add_attr_option<bool>("fast-math")  // implies all the below
    .add_attr_option<bool>("fast-math-nnan")
    .add_attr_option<bool>("fast-math-ninf")
    .add_attr_option<bool>("fast-math-nsz")
    .add_attr_option<bool>("fast-math-arcp")
    .add_attr_option<bool>("fast-math-contract")
    .add_attr_option<bool>("fast-math-reassoc")
    .add_attr_option<int64_t>("opt-level")
    // LLVM command line flags, see below
    .add_attr_option<Array<String>>("cl-opt")
    // LLVM JIT engine mcjit/orcjit
    .add_attr_option<String>("jit")
    // TVM & LLVM custom vector bit width
    .add_attr_option<int64_t>("vector-width")
    .set_default_keys({"cpu"})
    // Force the external codegen kind attribute to be registered, even if no external
    // codegen targets are enabled by the TVM build.
    .set_target_parser(tvm::target::parsers::cpu::ParseTarget);

// Note regarding the "cl-opt" attribute:
// Each string in the array has the format
//   -optionname[[:type]=value]
// where
//   * optionname is the actual LLVM option (e.g. "unroll-threshold")
//   * type is one of "bool", "int", "uint", or "string"
//   * value is the corresponding option value (for "bool" type is can be 0 or "false"
//     for false value, or 1 or "true" for true value)
// If type is omitted, it is assumed to be "bool". If value is omitted, it is assumed
// to be "true".
//
// The type must match the option type in LLVM. To find the type, search the LLVM
// repository (https://github.com/llvm/llvm-project) for optionname, and look for
// its definition: it will be a declaration of a variable of type cl::opt<T> with
// optionname being an argument to the constructor. The T in the declaration is
// the type.
// For example, for unroll-threshold, we get the following declaration:
// static cl::opt<unsigned>
//     UnrollThreshold("unroll-threshold", cl::Hidden,
//                     cl::desc("The cost threshold for loop unrolling"));
// Hence the type is "uint".

TVM_REGISTER_TARGET_KIND("c", kDLCPU)
    .add_attr_option<String>("mcpu")
    .add_attr_option<String>("march")
    .add_attr_option<int64_t>("workspace-byte-alignment")
    .add_attr_option<int64_t>("constants-byte-alignment")
    .set_default_keys({"cpu"})
    .set_target_parser(tvm::target::parsers::cpu::ParseTarget);

TVM_REGISTER_TARGET_KIND("cuda", kDLCUDA)
    .add_attr_option<String>("mcpu")
    .add_attr_option<String>("arch")
    .add_attr_option<int64_t>("max_shared_memory_per_block")
    .add_attr_option<int64_t>("max_threads_per_block")
    .add_attr_option<int64_t>("thread_warp_size", 32)
    .add_attr_option<int64_t>("registers_per_block")
    .add_attr_option<int64_t>("l2_cache_size_bytes")
    .add_attr_option<int64_t>("max_num_threads", 1024)  // TODO(@zxybazh): deprecate it
    .set_default_keys({"cuda", "gpu"})
    .set_target_parser(UpdateCUDAAttrs);

TVM_REGISTER_TARGET_KIND("nvptx", kDLCUDA)
    .add_attr_option<String>("mcpu")
    .add_attr_option<String>("mtriple")
    .add_attr_option<int64_t>("max_num_threads", 1024)
    .add_attr_option<int64_t>("thread_warp_size", 32)
    .set_default_keys({"cuda", "gpu"})
    .set_target_parser(UpdateNVPTXAttrs);

TVM_REGISTER_TARGET_KIND("rocm", kDLROCM)
    .add_attr_option<String>("mcpu")
    .add_attr_option<String>("mtriple")
    .add_attr_option<Array<String>>("mattr")
    // TODO(masahi): Support querying from a target device
    // On RDNA cards, thread_warp_size should be 32
    .add_attr_option<int64_t>("max_num_threads", 256)
    .add_attr_option<int64_t>("max_threads_per_block", 256)
    .add_attr_option<int64_t>("max_shared_memory_per_block", 65536)
    .add_attr_option<int64_t>("thread_warp_size", 64)
    .set_default_keys({"rocm", "gpu"})
    .set_target_parser(UpdateROCmAttrs);

TVM_REGISTER_TARGET_KIND("opencl", kDLOpenCL)
    .add_attr_option<int64_t>("max_threads_per_block", 256)
    .add_attr_option<int64_t>("max_shared_memory_per_block", 16384)
    .add_attr_option<int64_t>("max_num_threads", 256)
    .add_attr_option<int64_t>("thread_warp_size", 1)
    .add_attr_option<int64_t>("texture_spatial_limit", 16384)
    // Faced that Qualcomm OpenCL runtime crashed without any error message in
    // the case when the number of kernel arguments was pretty big. OpenCL doesn't
    // specify any limitations on the number of kernel arguments. max_function_args
    // equals to 128 looks like a reasonable number of kernel arguments.
    .add_attr_option<int64_t>("max_function_args", 128)
    .add_attr_option<int64_t>("image_base_address_alignment", 64)
    .set_default_keys({"opencl", "gpu"});

// The metal has some limitations on the number of input parameters. This is why attribute
// `max_function_args` was introduced. It specifies the maximum number of kernel argumetns. More
// information about this limitation can be found here:
// https://developer.apple.com/documentation/metal/buffers/about_argument_buffers?language=objc
// See also https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf
TVM_REGISTER_TARGET_KIND("metal", kDLMetal)
    .add_attr_option<int64_t>("max_num_threads", 256)
    .add_attr_option<int64_t>("max_threads_per_block", 256)
    .add_attr_option<int64_t>("max_shared_memory_per_block", 32768)
    .add_attr_option<int64_t>("thread_warp_size", 16)
    .add_attr_option<int64_t>("max_function_args", 31)
    .set_default_keys({"metal", "gpu"});

TVM_REGISTER_TARGET_KIND("vulkan", kDLVulkan)
    .add_attr_option<Array<String>>("mattr")
    // Feature support
    .add_attr_option<bool>("supports_float16")
    .add_attr_option<bool>("supports_float32", true)
    .add_attr_option<bool>("supports_float64")
    .add_attr_option<bool>("supports_int8")
    .add_attr_option<bool>("supports_int16")
    .add_attr_option<bool>("supports_int32", true)
    .add_attr_option<bool>("supports_int64")
    .add_attr_option<bool>("supports_8bit_buffer")
    .add_attr_option<bool>("supports_16bit_buffer")
    .add_attr_option<bool>("supports_storage_buffer_storage_class")
    .add_attr_option<bool>("supports_push_descriptor")
    .add_attr_option<bool>("supports_dedicated_allocation")
    .add_attr_option<bool>("supports_integer_dot_product")
    .add_attr_option<bool>("supports_cooperative_matrix")
    .add_attr_option<int64_t>("supported_subgroup_operations")
    // Physical device limits
    .add_attr_option<int64_t>("max_num_threads", 256)
    .add_attr_option<int64_t>("max_threads_per_block", 256)
    .add_attr_option<int64_t>("thread_warp_size", 1)
    .add_attr_option<int64_t>("max_block_size_x")
    .add_attr_option<int64_t>("max_block_size_y")
    .add_attr_option<int64_t>("max_block_size_z")
    .add_attr_option<int64_t>("max_push_constants_size")
    .add_attr_option<int64_t>("max_uniform_buffer_range")
    .add_attr_option<int64_t>("max_storage_buffer_range")
    .add_attr_option<int64_t>("max_per_stage_descriptor_storage_buffer")
    .add_attr_option<int64_t>("max_shared_memory_per_block")
    // Other device properties
    .add_attr_option<String>("device_type")
    .add_attr_option<String>("device_name")
    .add_attr_option<String>("driver_name")
    .add_attr_option<int64_t>("driver_version")
    .add_attr_option<int64_t>("vulkan_api_version")
    .add_attr_option<int64_t>("max_spirv_version")
    // Tags
    .set_default_keys({"vulkan", "gpu"});

TVM_REGISTER_TARGET_KIND("webgpu", kDLWebGPU)
    .add_attr_option<int64_t>("max_num_threads", 256)
    .set_default_keys({"webgpu", "gpu"});

TVM_REGISTER_TARGET_KIND("hexagon", kDLHexagon)
    .add_attr_option<Array<String>>("mattr")
    .add_attr_option<String>("mcpu")
    .add_attr_option<String>("mtriple")
    .add_attr_option<Array<String>>("llvm-options")
    .add_attr_option<int64_t>("num-cores")
    .add_attr_option<int64_t>("vtcm-capacity")
    .set_default_keys({"hexagon", "cpu"});

TVM_REGISTER_TARGET_KIND("ext_dev", kDLExtDev);

TVM_REGISTER_TARGET_KIND("hybrid", kDLCPU);

TVM_REGISTER_TARGET_KIND("composite", kDLCPU)  // line break
    .add_attr_option<Array<Target>>("devices");

TVM_REGISTER_TARGET_KIND("test", kDLCPU)  // line break
    .set_target_parser(TestTargetParser);

/**********  Registry  **********/

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef()
      .def("target.TargetKindGetAttr",
           [](TargetKind kind, String attr_name) -> ffi::Any {
             auto target_attr_map = TargetKind::GetAttrMap<ffi::Any>(attr_name);
             ffi::Any rv;
             if (target_attr_map.count(kind)) {
               rv = target_attr_map[kind];
             }
             return rv;
           })
      .def("target.ListTargetKinds", TargetKindRegEntry::ListTargetKinds)
      .def("target.ListTargetKindOptions", TargetKindRegEntry::ListTargetKindOptions)
      .def("target.ListTargetKindOptionsFromName", [](String target_kind_name) {
        TargetKind kind = TargetKind::Get(target_kind_name).value();
        return TargetKindRegEntry::ListTargetKindOptions(kind);
      });
});

}  // namespace tvm
