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
#include <tvm/ffi/reflection/registry.h>

#include "./utils.h"

namespace tvm {
namespace meta_schedule {

/*!
 * \brief Find the entry function of the given IRModule, i.e, functions marked by
 * `tir::attr::kIsEntryFunc`, whose name is `main` or being the only PrimeFunc.
 * \param mod The IRModule to find the entry function.
 * \return The entry function.
 */
inline tir::PrimFunc FindEntryFunc(const IRModule& mod) {
  // Priority 1: PrimFunc marked as `tir::attr::kIsEntryFunc`
  int num_prim_func = 0;
  const tir::PrimFuncNode* main_func = nullptr;
  const tir::PrimFuncNode* last_func = nullptr;
  for (const auto& kv : mod->functions) {
    GlobalVar gv = kv.first;
    BaseFunc base_func = kv.second;
    if (const auto* func = base_func.as<tir::PrimFuncNode>()) {
      last_func = func;
      if (func->HasNonzeroAttr(tir::attr::kIsEntryFunc)) {
        return GetRef<tir::PrimFunc>(func);
      }
      if (gv->name_hint == "main") {
        main_func = func;
      }
      ++num_prim_func;
    }
  }
  // Priority 2: PrimFunc whose name is `main`
  if (main_func != nullptr) {
    return GetRef<tir::PrimFunc>(main_func);
  }
  // Priority 3: The only PrimFunc in the IRModule
  if (num_prim_func == 0) {
    LOG(FATAL) << "ValueError: Cannot find any PrimFunc in the given IRModule: " << mod;
  }
  if (num_prim_func > 1) {
    LOG(FATAL) << "ValueError: Multiple PrimFuncs exist in the IRModule, but none of them are "
                  "annotated with `kIsEntryFunc`, i.e. `tir.is_entry_func`"
               << mod;
  }
  return GetRef<tir::PrimFunc>(last_func);
}
/******** ArgInfo ********/

ArgInfo ArgInfo::FromJSON(const ObjectRef& json_obj) {
  // The JSON object is always an array whose first element is a tag. For example:
  // `['TENSOR', 'float32', [1, 224, 224, 3]]
  // Step 1. Extract the tag
  Optional<String> tag{std::nullopt};
  try {
    const ffi::ArrayObj* json_array = json_obj.as<ffi::ArrayObj>();
    CHECK(json_array && json_array->size() >= 1);
    tag = json_array->at(0).cast<String>();
  } catch (const std::runtime_error& e) {  // includes tvm::Error and dmlc::Error
    LOG(FATAL) << "ValueError: Unable to parse the JSON object: " << json_obj
               << "\nThe error is: " << e.what();
  }
  // Step 2. Dispatch the tag to corresponding subclass of ArgInfo
  if (tag == "TENSOR") {
    return TensorInfo::FromJSON(json_obj);
  }
  LOG(FATAL) << "ValueError: Unable to parse the JSON object: " << json_obj;
  throw;
}

Array<ArgInfo> ArgInfo::FromPrimFunc(const tir::PrimFunc& func) {
  using support::AsVector;
  Array<ArgInfo> result;
  result.reserve(func->params.size());
  for (const tir::Var& arg : func->params) {
    if (Optional<tir::Buffer> _buffer = func->buffer_map.Get(arg)) {
      tir::Buffer buffer = _buffer.value();
      result.push_back(TensorInfo(/*dtype=*/buffer->dtype,
                                  /*shape=*/AsVector<PrimExpr, int64_t>(buffer->shape)));
    } else {
      LOG(FATAL) << "ValueError: Unsupported argument type: " << arg;
    }
  }
  return result;
}

Array<ArgInfo> ArgInfo::FromEntryFunc(const IRModule& mod, bool remove_preproc) {
  if (remove_preproc) {
    IRModule new_mod =
        tir::transform::RemoveWeightLayoutRewriteBlock(/*skip_ndarray_rewrite*/ true)(mod);
    return ArgInfo::FromPrimFunc(FindEntryFunc(new_mod));
  }
  return ArgInfo::FromPrimFunc(FindEntryFunc(mod));
}

/******** TensorInfo ********/

TensorInfo::TensorInfo(runtime::DataType dtype, ffi::Shape shape) {
  ObjectPtr<TensorInfoNode> n = make_object<TensorInfoNode>();
  n->dtype = dtype;
  n->shape = shape;
  this->data_ = std::move(n);
}

ObjectRef TensorInfoNode::AsJSON() const {
  static String tag = "TENSOR";
  String dtype = DLDataTypeToString(this->dtype);
  Array<Integer> shape = support::AsArray(this->shape);
  return Array<ffi::Any>{tag, dtype, shape};
}

TensorInfo TensorInfo::FromJSON(const ObjectRef& json_obj) {
  DLDataType dtype;
  Array<Integer> shape;
  try {
    const ffi::ArrayObj* json_array = json_obj.as<ffi::ArrayObj>();
    CHECK(json_array && json_array->size() == 3);
    // Load json[1] => dtype
    {
      String dtype_str = json_array->at(1).cast<String>();
      dtype = StringToDLDataType(dtype_str);
    }
    // Load json[2] => shape
    shape = AsIntArray(json_array->at(2).cast<ObjectRef>());
  } catch (const std::runtime_error& e) {  // includes tvm::Error and dmlc::Error
    LOG(FATAL) << "ValueError: Unable to parse the JSON object: " << json_obj
               << "\nThe error is: " << e.what();
  }
  std::vector<int64_t> s;
  std::transform(shape.begin(), shape.end(), std::back_inserter(s),
                 [](Integer i) { return i.IntValue(); });
  return TensorInfo(DataType(dtype), ffi::Shape(s.begin(), s.end()));
}

/******** Repr ********/

TVM_STATIC_IR_FUNCTOR(ReprPrinter, vtable)
    .set_dispatch<TensorInfoNode>([](const ObjectRef& n, ReprPrinter* p) {
      const auto* self = n.as<TensorInfoNode>();
      ICHECK(self);
      p->stream << "TensorInfo(\"" << self->dtype << "\", " << self->shape << ")";
    });

/******** FFI ********/
TVM_FFI_STATIC_INIT_BLOCK({ TensorInfoNode::RegisterReflection(); });

TVM_REGISTER_OBJECT_TYPE(ArgInfoNode);
TVM_REGISTER_NODE_TYPE(TensorInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef()
      .def_method("meta_schedule.ArgInfoAsJSON", &ArgInfoNode::AsJSON)
      .def("meta_schedule.ArgInfoFromPrimFunc", ArgInfo::FromPrimFunc)
      .def("meta_schedule.ArgInfoFromEntryFunc", ArgInfo::FromEntryFunc)
      .def("meta_schedule.ArgInfoFromJSON", ArgInfo::FromJSON)
      .def("meta_schedule.TensorInfo", [](runtime::DataType dtype, ffi::Shape shape) -> TensorInfo {
        return TensorInfo(dtype, shape);
      });
});

}  // namespace meta_schedule
}  // namespace tvm
