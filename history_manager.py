"""
History Manager: 이력 기반 추론 모듈
=====================================
/분석구현 Agent 구현

기능:
- 과거 제출 이력 저장 및 조회
- 필드별 최빈값/최근값 추론
- 컨텍스트 기반 추론 (예: 휴가 유형별 사유)

구조:
- .history.json: 이력 저장 파일
- submissions: 제출 이력 목록
- field_stats: 필드별 통계

추론 방식:
1. mode (최빈값): 가장 자주 사용된 값
2. recent (최근값): 가장 최근에 사용된 값
3. context_mode (컨텍스트 최빈값): 특정 조건에서의 최빈값
"""

import json
import fcntl
import os
from pathlib import Path
from datetime import datetime
from collections import Counter, defaultdict
from typing import Optional, Dict, Any, List, Tuple


class HistoryManager:
    """이력 기반 추론 관리자"""

    # 이력 추론 대상 필드 정의
    HISTORY_FIELDS = {
        "leave": {
            "substitute": {"method": "mode", "confidence_threshold": 3},
            "destination": {"method": "context_mode", "context_key": "leave_type", "confidence_threshold": 2},
            "purpose": {"method": "context_mode", "context_key": "leave_type", "confidence_threshold": 2},
            "emergency_address": {"method": "mode", "confidence_threshold": 1},  # 거의 고정
            "emergency_telephone": {"method": "mode", "confidence_threshold": 1},  # 거의 고정
        },
        "working": {
            "budget_code": {"method": "recent", "confidence_threshold": 1},
            "work_place": {"method": "mode", "confidence_threshold": 2},
        },
        "expense": {
            "budget_code": {"method": "recent", "confidence_threshold": 1},
        },
        "travel": {
            # Travel은 연결 문서에서 대부분 추론하므로 이력 기반 적음
        }
    }

    def __init__(self, history_file: Optional[Path] = None):
        """
        Args:
            history_file: 이력 파일 경로 (기본: .history.json)
        """
        self.history_file = history_file or Path(__file__).parent / ".history.json"
        self.data = self._load()

    def _load(self) -> Dict:
        """이력 파일 로드 (파일 잠금 적용)"""
        if self.history_file.exists():
            try:
                with open(self.history_file, 'r') as f:
                    fcntl.flock(f, fcntl.LOCK_SH)  # 공유 잠금 (읽기)
                    try:
                        data = json.load(f)
                    finally:
                        fcntl.flock(f, fcntl.LOCK_UN)
                    return data
            except (json.JSONDecodeError, IOError):
                pass

        # 초기 구조
        return {
            "version": "1.0",
            "created_at": datetime.now().isoformat(),
            "submissions": [],
            "field_stats": {}
        }

    def _save(self):
        """이력 파일 저장 (파일 잠금 적용)"""
        self.data["updated_at"] = datetime.now().isoformat()

        # 배타적 잠금으로 안전하게 저장
        with open(self.history_file, 'w') as f:
            fcntl.flock(f, fcntl.LOCK_EX)  # 배타 잠금 (쓰기)
            try:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

        self.history_file.chmod(0o600)  # 보안: 소유자만 읽기/쓰기

    def record_submission(
        self,
        form_type: str,
        fields: Dict[str, Any],
        doc_id: Optional[str] = None,
        success: bool = True
    ):
        """
        제출 이력 기록

        Args:
            form_type: 폼 유형 (leave, working, expense, travel)
            fields: 필드명-값 딕셔너리
            doc_id: 생성된 문서 ID
            success: 성공 여부
        """
        submission = {
            "timestamp": datetime.now().isoformat(),
            "form_type": form_type,
            "doc_id": doc_id,
            "success": success,
            "fields": fields
        }

        self.data["submissions"].append(submission)

        # 필드 통계 업데이트
        self._update_field_stats(form_type, fields)

        # 최근 100개만 유지 (메모리 관리)
        if len(self.data["submissions"]) > 100:
            self.data["submissions"] = self.data["submissions"][-100:]

        self._save()

    def _update_field_stats(self, form_type: str, fields: Dict[str, Any]):
        """필드 통계 업데이트"""
        if form_type not in self.data["field_stats"]:
            self.data["field_stats"][form_type] = {}

        stats = self.data["field_stats"][form_type]

        for field_name, value in fields.items():
            if not value or not str(value).strip():
                continue

            value_str = str(value).strip()

            if field_name not in stats:
                stats[field_name] = {
                    "values": [],  # 최근 20개 값
                    "counter": {},  # 값별 빈도
                    "context_counter": {}  # 컨텍스트별 빈도
                }

            field_stat = stats[field_name]

            # 최근 값 목록 (최근 20개)
            field_stat["values"].append({
                "value": value_str,
                "timestamp": datetime.now().isoformat()
            })
            if len(field_stat["values"]) > 20:
                field_stat["values"] = field_stat["values"][-20:]

            # 전체 빈도
            if value_str not in field_stat["counter"]:
                field_stat["counter"][value_str] = 0
            field_stat["counter"][value_str] += 1

            # 컨텍스트별 빈도 (leave_type, budget_type 등)
            context_key = self._get_context_key(form_type, field_name)
            if context_key and context_key in fields:
                context_value = str(fields[context_key])
                if context_value not in field_stat["context_counter"]:
                    field_stat["context_counter"][context_value] = {}
                if value_str not in field_stat["context_counter"][context_value]:
                    field_stat["context_counter"][context_value][value_str] = 0
                field_stat["context_counter"][context_value][value_str] += 1

    def _get_context_key(self, form_type: str, field_name: str) -> Optional[str]:
        """필드의 컨텍스트 키 반환"""
        field_config = self.HISTORY_FIELDS.get(form_type, {}).get(field_name, {})
        return field_config.get("context_key")

    def infer(
        self,
        form_type: str,
        field_name: str,
        context: Optional[Dict[str, str]] = None
    ) -> Tuple[Optional[str], float, str]:
        """
        필드 값 추론

        Args:
            form_type: 폼 유형
            field_name: 필드명
            context: 컨텍스트 정보 (예: {"leave_type": "annual"})

        Returns:
            Tuple[추론값, 신뢰도(0-1), 추론방법]
        """
        field_config = self.HISTORY_FIELDS.get(form_type, {}).get(field_name)
        if not field_config:
            return None, 0.0, "not_configured"

        stats = self.data.get("field_stats", {}).get(form_type, {}).get(field_name)
        if not stats:
            return None, 0.0, "no_history"

        method = field_config.get("method", "mode")
        threshold = field_config.get("confidence_threshold", 3)

        if method == "mode":
            return self._infer_mode(stats, threshold)
        elif method == "recent":
            return self._infer_recent(stats, threshold)
        elif method == "context_mode":
            context_key = field_config.get("context_key")
            context_value = context.get(context_key) if context else None
            return self._infer_context_mode(stats, context_value, threshold)

        return None, 0.0, "unknown_method"

    def _infer_mode(self, stats: Dict, threshold: int) -> Tuple[Optional[str], float, str]:
        """최빈값 추론"""
        counter = stats.get("counter", {})
        if not counter:
            return None, 0.0, "no_data"

        # 가장 빈도 높은 값
        most_common = max(counter.items(), key=lambda x: x[1])
        value, count = most_common

        total = sum(counter.values())
        confidence = min(1.0, count / max(threshold, 1))

        if count < threshold:
            return value, confidence * 0.5, f"mode_low_confidence({count}/{threshold})"

        return value, confidence, f"mode({count}/{total})"

    def _infer_recent(self, stats: Dict, threshold: int) -> Tuple[Optional[str], float, str]:
        """최근값 추론"""
        values = stats.get("values", [])
        if not values:
            return None, 0.0, "no_data"

        # 가장 최근 값
        recent = values[-1]
        value = recent.get("value")

        # 신뢰도: 최근 값이 얼마나 반복되는지
        recent_values = [v.get("value") for v in values[-5:]]
        same_count = recent_values.count(value)
        confidence = same_count / len(recent_values)

        if len(values) < threshold:
            return value, confidence * 0.5, f"recent_low_history({len(values)})"

        return value, confidence, f"recent({same_count}/5)"

    def _infer_context_mode(
        self,
        stats: Dict,
        context_value: Optional[str],
        threshold: int
    ) -> Tuple[Optional[str], float, str]:
        """컨텍스트별 최빈값 추론"""
        if not context_value:
            # 컨텍스트 없으면 전체 최빈값으로 fallback
            return self._infer_mode(stats, threshold)

        context_counter = stats.get("context_counter", {}).get(context_value, {})
        if not context_counter:
            # 해당 컨텍스트 데이터 없으면 전체 최빈값으로 fallback
            result = self._infer_mode(stats, threshold)
            return result[0], result[1] * 0.7, f"fallback_mode_no_context({context_value})"

        # 컨텍스트 내 최빈값
        most_common = max(context_counter.items(), key=lambda x: x[1])
        value, count = most_common

        total = sum(context_counter.values())
        confidence = min(1.0, count / max(threshold, 1))

        if count < threshold:
            return value, confidence * 0.5, f"context_mode_low({context_value}:{count}/{threshold})"

        return value, confidence, f"context_mode({context_value}:{count}/{total})"

    def get_all_inferences(
        self,
        form_type: str,
        context: Optional[Dict[str, str]] = None
    ) -> Dict[str, Dict]:
        """
        폼의 모든 이력 기반 필드 추론

        Returns:
            {field_name: {"value": ..., "confidence": ..., "method": ...}}
        """
        fields = self.HISTORY_FIELDS.get(form_type, {})
        results = {}

        for field_name in fields:
            value, confidence, method = self.infer(form_type, field_name, context)
            if value is not None:
                results[field_name] = {
                    "value": value,
                    "confidence": confidence,
                    "method": method
                }

        return results

    def get_stats_summary(self) -> Dict:
        """통계 요약"""
        summary = {
            "total_submissions": len(self.data.get("submissions", [])),
            "forms": {}
        }

        for form_type, fields in self.data.get("field_stats", {}).items():
            summary["forms"][form_type] = {
                "fields_tracked": len(fields),
                "field_names": list(fields.keys())
            }

        return summary

    def clear_history(self, form_type: Optional[str] = None):
        """이력 삭제"""
        if form_type:
            self.data["submissions"] = [
                s for s in self.data["submissions"]
                if s.get("form_type") != form_type
            ]
            if form_type in self.data.get("field_stats", {}):
                del self.data["field_stats"][form_type]
        else:
            self.data["submissions"] = []
            self.data["field_stats"] = {}

        self._save()


# 싱글톤 인스턴스
_history_manager: Optional[HistoryManager] = None


def get_history_manager() -> HistoryManager:
    """히스토리 매니저 싱글톤 반환"""
    global _history_manager
    if _history_manager is None:
        _history_manager = HistoryManager()
    return _history_manager


def infer_field(
    form_type: str,
    field_name: str,
    context: Optional[Dict[str, str]] = None
) -> Tuple[Optional[str], float, str]:
    """편의 함수: 필드 값 추론"""
    return get_history_manager().infer(form_type, field_name, context)


def record_submission(
    form_type: str,
    fields: Dict[str, Any],
    doc_id: Optional[str] = None,
    success: bool = True
):
    """편의 함수: 제출 이력 기록"""
    get_history_manager().record_submission(form_type, fields, doc_id, success)


if __name__ == "__main__":
    # 테스트/데모
    import sys

    hm = HistoryManager()

    if len(sys.argv) > 1 and sys.argv[1] == "demo":
        # 샘플 데이터 기록
        print("샘플 이력 기록 중...")

        # Leave 샘플
        for i in range(5):
            hm.record_submission("leave", {
                "leave_type": "annual",
                "substitute": "Guinam Wee",
                "destination": "Seoul",
                "purpose": "personal",
                "emergency_address": "Seoul, Korea",
                "emergency_telephone": "010-1234-5678"
            }, doc_id=f"demo-{i}")

        for i in range(3):
            hm.record_submission("leave", {
                "leave_type": "compensatory",
                "substitute": "Guinam Wee",
                "destination": "Seoul",
                "purpose": "child care",
                "emergency_address": "Seoul, Korea",
                "emergency_telephone": "010-1234-5678"
            }, doc_id=f"demo-comp-{i}")

        # Working 샘플
        for i in range(4):
            hm.record_submission("working", {
                "budget_code": "NN2512-0001",
                "work_place": "IPK"
            }, doc_id=f"demo-work-{i}")

        print("샘플 기록 완료!\n")

    # 추론 테스트
    print("=" * 60)
    print("이력 기반 추론 테스트")
    print("=" * 60)

    print("\n[Leave - Annual]")
    inferences = hm.get_all_inferences("leave", {"leave_type": "annual"})
    for field, result in inferences.items():
        conf = f"{result['confidence']:.0%}"
        print(f"  {field}: {result['value']} ({conf}, {result['method']})")

    print("\n[Leave - Compensatory]")
    inferences = hm.get_all_inferences("leave", {"leave_type": "compensatory"})
    for field, result in inferences.items():
        conf = f"{result['confidence']:.0%}"
        print(f"  {field}: {result['value']} ({conf}, {result['method']})")

    print("\n[Working]")
    inferences = hm.get_all_inferences("working")
    for field, result in inferences.items():
        conf = f"{result['confidence']:.0%}"
        print(f"  {field}: {result['value']} ({conf}, {result['method']})")

    print("\n[통계 요약]")
    summary = hm.get_stats_summary()
    print(f"  총 제출 이력: {summary['total_submissions']}개")
    for form_type, info in summary.get("forms", {}).items():
        print(f"  {form_type}: {info['fields_tracked']}개 필드 추적")
