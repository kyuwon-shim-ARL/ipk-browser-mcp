"""서류 패턴 분석"""
import json
import re
from collections import defaultdict

# 내 서류 로드
with open("screenshots/approved_docs/doc_list.json", "r") as f:
    my_docs = json.load(f)

# 팀 서류 로드
with open("screenshots/group_docs/group_doc_list.json", "r") as f:
    team_docs = json.load(f)

all_docs = my_docs + team_docs
print(f"총 {len(all_docs)}건 분석\n")

# 서류 종류별 분류 및 패턴 추출
categories = defaultdict(list)

for doc in all_docs:
    subj = doc['subject']
    subj_lower = subj.lower()

    # 카테고리 판별
    if 'annual leave' in subj_lower:
        categories['연차휴가'].append(doc)
    elif 'compensatory leave' in subj_lower:
        categories['보상휴가'].append(doc)
    elif 'paternity leave' in subj_lower:
        categories['육아휴직'].append(doc)
    elif 'childcare leave' in subj_lower:
        categories['육아휴직'].append(doc)
    elif 'application for working' in subj_lower:
        categories['휴일근무신청'].append(doc)
    elif '[card]' in subj_lower and ('overtime' in subj_lower or 'meal' in subj_lower):
        categories['야근식대'].append(doc)
    elif '[card]' in subj_lower and 'expense' in subj_lower:
        categories['R&D경비(카드)'].append(doc)
    elif '[card]' in subj_lower:
        categories['기타카드경비'].append(doc)
    elif '[settlement]' in subj_lower:
        categories['정산서'].append(doc)
    elif '[request]' in subj_lower and ('travel' in subj_lower or 'overseas' in subj_lower):
        categories['해외출장요청'].append(doc)
    elif '[request]' in subj_lower:
        categories['기타요청'].append(doc)
    elif 'budget transfer' in subj_lower:
        categories['예산이체'].append(doc)
    else:
        categories['기타'].append(doc)

# 결과 출력
print("=" * 60)
print("서류 종류별 분석")
print("=" * 60)

for cat, docs in sorted(categories.items(), key=lambda x: -len(x[1])):
    print(f"\n## {cat} ({len(docs)}건)")
    print("-" * 40)

    # 제목 패턴 분석
    subjects = [d['subject'] for d in docs]
    writers = set(d['writer'] for d in docs)

    print(f"작성자: {', '.join(writers)}")
    print(f"제목 예시:")
    for subj in subjects[:3]:
        print(f"  - {subj[:70]}")

    # 제목 패턴 추출
    if cat == '연차휴가':
        print(f"\n제목 패턴: 'Annual leave, YYYY-MM-DD~YYYY-MM-DD, [주소], [이름]'")
    elif cat == '보상휴가':
        print(f"\n제목 패턴: 'Compensatory leave, YYYY-MM-DD~YYYY-MM-DD, [주소], [이름]'")
    elif cat == '휴일근무신청':
        print(f"\n제목 패턴: 'Application for Working on YYYY-MM-DD, [이름]'")
    elif cat == '야근식대':
        print(f"\n제목 패턴: '[Card] overtime meal' 또는 '[Card] ER_overtime meal_YYYYMMDD_[이니셜]_ARL'")
    elif cat == 'R&D경비(카드)':
        print(f"\n제목 패턴: '[Card] R&D Expense Request_[품목]'")

# JSON으로 분석 결과 저장
analysis = {}
for cat, docs in categories.items():
    analysis[cat] = {
        "count": len(docs),
        "writers": list(set(d['writer'] for d in docs)),
        "sample_subjects": [d['subject'] for d in docs[:5]],
        "sample_doc_nos": [d['doc_no'] for d in docs[:5]]
    }

with open("screenshots/doc_analysis.json", "w", encoding="utf-8") as f:
    json.dump(analysis, f, ensure_ascii=False, indent=2)

print("\n\n분석 결과 저장: screenshots/doc_analysis.json")
