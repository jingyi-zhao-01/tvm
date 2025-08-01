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
 *
 * \file analysis.cc
 *
 * \brief Analysis functions for Relax.
 */

#include <tvm/ffi/reflection/registry.h>
#include <tvm/relax/analysis.h>
#include <tvm/relax/expr_functor.h>
#include <tvm/tir/expr_functor.h>

namespace tvm {
namespace relax {

template <typename T>
struct InsertionSet {
  std::unordered_set<T, ObjectPtrHash, ObjectPtrEqual> set;
  std::vector<T> data;
  void Insert(const T& t) {
    if (set.count(t) == 0) {
      set.insert(t);
      data.push_back(t);
    }
  }
};

class VarVisitor : protected ExprVisitor {
 public:
  Array<Var> Free(const Expr& expr) {
    this->VisitExpr(expr);
    Array<Var> ret;
    for (const auto& v : vars_.data) {
      if (bound_vars_.set.count(v) == 0) {
        ret.push_back(v);
      }
    }
    return ret;
  }

  Array<Var> Collect() {
    Array<Var> ret;
    for (const auto& v : bound_vars_.data) {
      ret.push_back(v);
    }
    return ret;
  }

  Array<Var> Bound(const Expr& expr) {
    this->VisitExpr(expr);
    return Collect();
  }

  Array<Var> All(const Expr& expr) {
    this->VisitExpr(expr);
    Array<Var> ret;
    for (const auto& v : vars_.data) {
      ret.push_back(v);
    }
    return ret;
  }

  Array<GlobalVar> AllGlobalVars(const Expr& expr) {
    this->VisitExpr(expr);
    Array<GlobalVar> ret;
    for (const auto& v : global_vars_.data) {
      ret.push_back(v);
    }
    return ret;
  }

  void MarkBounded(const Var& v) {
    bound_vars_.Insert(v);
    vars_.Insert(v);
  }

  void VisitExpr_(const VarNode* var) final { vars_.Insert(GetRef<Var>(var)); }

  void VisitExpr_(const FunctionNode* op) final {
    for (const auto& param : op->params) {
      MarkBounded(param);
    }
    VisitExpr(op->body);
  }

  void VisitExpr_(const GlobalVarNode* op) final { global_vars_.Insert(GetRef<GlobalVar>(op)); }

  void VisitExpr_(const CallNode* call_node) final {
    VisitSpan(call_node->span);
    VisitExpr(call_node->op);

    for (StructInfo sinfo_arg : call_node->sinfo_args) {
      VisitExprDepStructInfoField(sinfo_arg);
    }

    for (Expr arg : call_node->args) {
      VisitExpr(arg);
    }
  }

  void VisitBinding_(const VarBindingNode* binding) final {
    MarkBounded(binding->var);
    VisitExpr(binding->value);
    VisitVarDef(binding->var);
  }

  void VisitBinding_(const MatchCastNode* binding) final {
    MarkBounded(binding->var);
    ExprVisitor::VisitBinding_(binding);
  }

 private:
  InsertionSet<Var> vars_;
  InsertionSet<Var> bound_vars_;
  InsertionSet<GlobalVar> global_vars_;
};

tvm::Array<Var> FreeVars(const Expr& expr) { return VarVisitor().Free(expr); }

tvm::Array<Var> BoundVars(const Expr& expr) { return VarVisitor().Bound(expr); }

tvm::Array<Var> AllVars(const Expr& expr) { return VarVisitor().All(expr); }

tvm::Array<GlobalVar> AllGlobalVars(const Expr& expr) { return VarVisitor().AllGlobalVars(expr); }

Optional<Expr> FindImpureCall(const Expr& expr, const Optional<Expr>& own_name) {
  class ImpureCallChecker : public ExprVisitor {
   public:
    static Optional<Expr> Check(const Expr& expr, const Optional<Expr>& own_name) {
      ImpureCallChecker visitor(own_name);
      visitor.VisitExpr(expr);
      return visitor.impure_expr_;
    }

   private:
    explicit ImpureCallChecker(const Optional<Expr>& own_name) : own_name_(own_name) {}

    void VisitExpr(const Expr& expr) override {
      // Early bail-out if we found an impure expression
      if (!impure_expr_) {
        ExprVisitor::VisitExpr(expr);
      }
    }

    void VisitExpr_(const FunctionNode* func) override {
      // we don't visit inner functions because an impure call in an inner function
      // does *not* mean the outer function contains an impure call
    }

    void VisitExpr_(const CallNode* call) override {
      // ignore recursive calls if we find one
      bool is_recursive = (own_name_ && own_name_.value().same_as(call->op));
      auto expr = GetRef<Call>(call);
      if (!is_recursive && IsImpureCall(expr)) {
        impure_expr_ = expr;
      } else {
        ExprVisitor::VisitExpr_(call);
      }
    }

   private:
    const Optional<Expr>& own_name_;
    Optional<Expr> impure_expr_ = std::nullopt;
  };

  if (own_name) {
    ICHECK(own_name.value().as<VarNode>() || own_name.value().as<GlobalVarNode>())
        << "Must pass a Var or GlobalVar for own_name";
  }

  Expr to_check = expr;
  if (auto func = to_check.as<FunctionNode>()) {
    to_check = func->body;
  }
  return ImpureCallChecker::Check(to_check, own_name);
}

bool ContainsImpureCall(const Expr& expr, const Optional<Expr>& own_name) {
  return FindImpureCall(expr, own_name).defined();
}

TVM_FFI_STATIC_INIT_BLOCK({
  namespace refl = tvm::ffi::reflection;
  refl::GlobalDef()
      .def("relax.analysis.free_vars", FreeVars)
      .def("relax.analysis.bound_vars", BoundVars)
      .def("relax.analysis.all_vars", AllVars)
      .def("relax.analysis.all_global_vars", AllGlobalVars)
      .def("relax.analysis.contains_impure_call", ContainsImpureCall);
});

}  // namespace relax
}  // namespace tvm
