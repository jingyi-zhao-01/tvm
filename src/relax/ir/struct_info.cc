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
 * \file src/relax/ir/struct_info.cc
 * \brief Relax struct info.
 */
#include <tvm/ffi/function.h>
#include <tvm/ffi/reflection/registry.h>
#include <tvm/relax/analysis.h>
#include <tvm/relax/struct_info.h>
#include <tvm/relax/struct_info_functor.h>

namespace tvm {
namespace relax {

TVM_FFI_STATIC_INIT_BLOCK({
  StructInfoNode::RegisterReflection();
  ObjectStructInfoNode::RegisterReflection();
  PrimStructInfoNode::RegisterReflection();
  ShapeStructInfoNode::RegisterReflection();
  TensorStructInfoNode::RegisterReflection();
  TupleStructInfoNode::RegisterReflection();
  FuncStructInfoNode::RegisterReflection();
});

ObjectStructInfo::ObjectStructInfo(Span span) {
  ObjectPtr<ObjectStructInfoNode> n = make_object<ObjectStructInfoNode>();
  n->span = span;
  data_ = std::move(n);
}

TVM_REGISTER_NODE_TYPE(ObjectStructInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef().def("relax.ObjectStructInfo", [](Span span) { return ObjectStructInfo(span); });
});

// Prim
PrimStructInfo::PrimStructInfo(PrimExpr value, Span span) {
  ObjectPtr<PrimStructInfoNode> n = make_object<PrimStructInfoNode>();
  n->dtype = value->dtype;
  n->value = std::move(value);
  n->span = span;
  data_ = std::move(n);
}

PrimStructInfo::PrimStructInfo(DataType dtype, Span span) {
  ObjectPtr<PrimStructInfoNode> n = make_object<PrimStructInfoNode>();
  n->dtype = dtype;
  n->value = std::nullopt;
  n->span = span;
  data_ = std::move(n);
}

TVM_REGISTER_NODE_TYPE(PrimStructInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef()
      .def("relax.PrimStructInfoFromDtype",
           [](DataType dtype, Span span) { return PrimStructInfo(dtype, span); })
      .def("relax.PrimStructInfoFromValue",
           [](PrimExpr value, Span span) { return PrimStructInfo(value, span); });
});

// Shape
ShapeStructInfo::ShapeStructInfo(Array<PrimExpr> values, Span span) {
  ObjectPtr<ShapeStructInfoNode> n = make_object<ShapeStructInfoNode>();
  n->ndim = static_cast<int>(values.size());
  n->values = values.Map([](PrimExpr value) {
    if (value->IsInstance<IntImmNode>()) {
      return tvm::cast(DataType::Int(64), value);
    }
    ICHECK(value.dtype() == DataType::Int(64))
        << "the value in ShapeStructInfo can only have dtype of int64";
    return value;
  });
  n->span = span;
  data_ = std::move(n);
}

ShapeStructInfo::ShapeStructInfo(int ndim, Span span) {
  ObjectPtr<ShapeStructInfoNode> n = make_object<ShapeStructInfoNode>();
  CHECK_GE(ndim, -1) << "ndim of ShapeStructInfo must be >= -1, but got " << ndim;
  n->ndim = ndim;
  n->span = span;
  data_ = std::move(n);
}

TVM_REGISTER_NODE_TYPE(ShapeStructInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef().def(
      "relax.ShapeStructInfo", [](Optional<Array<PrimExpr>> values, int ndim, Span span) {
        if (values.defined()) {
          CHECK_EQ(ndim, kUnknownNDim) << "ValueError: Cannot both specify values and ndim";
          return ShapeStructInfo(values.value(), span);
        } else {
          return ShapeStructInfo(ndim, span);
        }
      });
});

// Tensor
TensorStructInfo::TensorStructInfo(Expr shape, DataType dtype, Optional<VDevice> vdevice,
                                   Span span) {
  ObjectPtr<TensorStructInfoNode> n = make_object<TensorStructInfoNode>();
  // assign ndim before move
  Optional<ShapeStructInfo> sinfo = MatchStructInfo<ShapeStructInfo>(shape);
  ICHECK(sinfo) << "We expect shape to contain pre-set shape struct info";
  ICHECK(shape.defined()) << "Must provide a shape in this constructor";
  ICHECK(shape->IsInstance<ShapeExprNode>() || shape->IsInstance<VarNode>())
      << "We require shape to be normalized when constructing TensorStructInfo";
  n->ndim = sinfo.value()->ndim;
  // assign rest of the fields.
  n->shape = std::move(shape);
  n->dtype = dtype;
  n->vdevice = vdevice;
  n->span = span;
  data_ = std::move(n);
}

TensorStructInfo::TensorStructInfo(DataType dtype, int ndim, Optional<VDevice> vdevice, Span span) {
  ObjectPtr<TensorStructInfoNode> n = make_object<TensorStructInfoNode>();
  CHECK_GE(ndim, -1) << "ndim of TensorStructInfo must be >= -1, but got " << ndim;
  n->ndim = ndim;
  n->dtype = dtype;
  n->vdevice = vdevice;
  n->span = span;
  data_ = std::move(n);
}

TVM_REGISTER_NODE_TYPE(TensorStructInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef().def("relax.TensorStructInfo", [](Optional<Expr> shape, Optional<DataType> dtype,
                                                     int ndim, VDevice vdevice, Span span) {
    if (shape.defined()) {
      CHECK_EQ(ndim, kUnknownNDim) << "ValueError: Cannot both specify shape and ndim";
      return TensorStructInfo(shape.value(), dtype.value_or(DataType::Void()), vdevice, span);
    } else {
      return TensorStructInfo(dtype.value_or(DataType::Void()), ndim, vdevice, span);
    }
  });
});

// Tuple
TupleStructInfo::TupleStructInfo(Array<StructInfo> fields, Span span) {
  ObjectPtr<TupleStructInfoNode> n = make_object<TupleStructInfoNode>();
  n->fields = std::move(fields);
  n->span = span;
  data_ = std::move(n);
}

TVM_REGISTER_NODE_TYPE(TupleStructInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef().def("relax.TupleStructInfo", [](Array<StructInfo> fields, Span span) {
    return TupleStructInfo(fields, span);
  });
});

// Func
FuncStructInfo::FuncStructInfo(Array<StructInfo> params, StructInfo ret, bool purity, Span span) {
  ObjectPtr<FuncStructInfoNode> n = make_object<FuncStructInfoNode>();
  n->params = std::move(params);
  n->ret = std::move(ret);
  n->purity = std::move(purity);
  n->span = span;
  data_ = std::move(n);
}

FuncStructInfo FuncStructInfo::OpaqueFunc(StructInfoDeriveFunc derive_func, bool purity,
                                          Span span) {
  ObjectPtr<FuncStructInfoNode> n = make_object<FuncStructInfoNode>();
  n->derive_func = std::move(derive_func);
  n->ret = ObjectStructInfo();
  n->purity = std::move(purity);
  n->span = span;
  return FuncStructInfo(n);
}

FuncStructInfo FuncStructInfo::OpaqueFunc(StructInfo ret, bool purity, Span span) {
  ObjectPtr<FuncStructInfoNode> n = make_object<FuncStructInfoNode>();
  n->ret = std::move(ret);
  n->purity = std::move(purity);
  n->span = span;
  return FuncStructInfo(n);
}

TVM_REGISTER_NODE_TYPE(FuncStructInfoNode);

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef()
      .def("relax.FuncStructInfo",
           [](Array<StructInfo> params, StructInfo ret, bool purity, Span span) {
             return FuncStructInfo(params, ret, purity, span);
           })
      .def("relax.FuncStructInfoOpaqueFunc",
           [](Optional<StructInfo> ret, Optional<StructInfoDeriveFunc> derive_func, bool purity,
              Span span) {
             if (derive_func.defined()) {
               ICHECK(!ret.defined()) << "ValueError: Cannot specify both ret and derive_func";
               return FuncStructInfo::OpaqueFunc(derive_func.value(), purity, span);
             } else {
               return FuncStructInfo::OpaqueFunc(ret.value_or(ObjectStructInfo()), purity, span);
             }
           });
});

// Helper functions
void UpdateStructInfo(Expr expr, StructInfo struct_info) {
  ICHECK(!expr->struct_info_.defined())
      << "To ensure idempotency, "
      << "the expression passed to UpdateStructInfo "
      << "must not have any prior StructInfo.  "
      << "However, expression " << expr << " has struct info " << expr->struct_info_
      << ", which cannot be overwritten with " << struct_info;
  expr->struct_info_ = struct_info;
}

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef()
      .def("relax.UpdateStructInfo",
           [](Expr expr, StructInfo struct_info) { UpdateStructInfo(expr, struct_info); })
      .def("ir.ExprStructInfo", [](Expr expr) { return GetStructInfo(expr); });
});

}  // namespace relax
}  // namespace tvm
