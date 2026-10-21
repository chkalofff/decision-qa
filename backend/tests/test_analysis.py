"""Тесты детерминированного анализа прогона (assistant/analysis.py):
метрики карточки «Разбор прогона» и очередь «Что разметить дальше» —
чистые функции от снапшота (формат buildSnapshot фронта)."""
from __future__ import annotations

import pytest

from backend.assistant.analysis import (compute_run_analysis,
                                        compute_review_queue)


def _batch_snapshot() -> dict:
    """3 файла × 2 модели, 2 вопроса: расхождение по №2 в a.txt и c.txt,
    ячейка a.txt×№1×mB у порога (<70%), низкая уверенность в c.txt."""
    return {
        "page": "batch",
        "questions": [
            {"n": 1, "id": "q1", "question": "Есть жалоба?", "type": "yes_no"},
            {"n": 2, "id": "q2", "question": "Тема", "type": "choice",
             "options": ["цена", "качество"]},
        ],
        "decision": {"outcomes": [
            {"label": "Архив", "rules": [{"conditions": [
                {"question": "q1", "answer": "yes", "op": "lt",
                 "threshold": 70}]}]}]},
        "batchFiles": [{"num": 1, "id": "f1", "name": "a.txt"},
                       {"num": 2, "id": "f2", "name": "b.txt"},
                       {"num": 3, "id": "f3", "name": "c.txt"}],
        "batchResults": {
            "a.txt": {"mA": {"answers": {"1": "да · 55%", "2": "цена · 58%"}},
                      "mB": {"answers": {"1": "да · 80%", "2": "качество · 61%"}}},
            "b.txt": {"mA": {"answers": {"1": "нет · 90%", "2": "цена · 70%"}},
                      "mB": {"answers": {"1": "нет · 88%", "2": "цена · 66%"}}},
            "c.txt": {"mA": {"answers": {"1": "да · 52%", "2": "цена · 51%"}},
                      "mB": {"answers": {"1": "да · 57%", "2": "качество · 55%"}}},
        },
        "reviewMarks": {
            "totals": {"accept": 1, "reject": 2, "unsure": 0, "comments": 1},
            "items": ["файл №1 (a.txt) × вопрос №2 × 27B: ✗ «не заметил»"],
            "targets": [
                {"sc": "batch", "v": "reject", "c": "не заметил",
                 "f": "a.txt", "fid": "f1", "q": 2, "qid": "q2",
                 "m": "mA", "ml": "27B"},
                {"sc": "batch", "v": "reject",
                 "f": "b.txt", "fid": "f2", "q": 2, "qid": "q2", "m": "mB"},
                {"sc": "batch", "v": "accept",
                 "f": "b.txt", "fid": "f2", "q": 1, "qid": "q1", "m": "mA"},
            ],
        },
    }


def _single_snapshot() -> dict:
    """Одиночный прогон: 2 модели разошлись по №1, у 35B низкая уверенность."""
    return {
        "page": "single",
        "questions": [
            {"n": 1, "id": "q1", "question": "Есть жалоба?", "type": "yes_no"},
            {"n": 2, "id": "q2", "question": "Оценка", "type": "score",
             "levels": ["плохо", "средне", "хорошо"]},
        ],
        "singleResults": {
            "27B": [{"n": 1, "answer": "да · 87%"},
                    {"n": 2, "answer": "1.20"}],
            "35B": [{"n": 1, "answer": "нет · 52%"},
                    {"n": 2, "answer": "1.90"}],
        },
    }


# ------------------------------------------------------------------ разбор

def test_run_analysis_empty_when_no_results():
    assert compute_run_analysis({}) == {"empty": "no_results", "page": "single"}
    assert compute_run_analysis(None) == {"empty": "no_results",
                                          "page": "single"}
    out = compute_run_analysis({"page": "batch"})
    assert out == {"empty": "no_results", "page": "batch"}
    # results другой страницы не считаются
    snap = _single_snapshot()
    snap["page"] = "batch"
    assert compute_run_analysis(snap)["empty"] == "no_results"


def test_run_analysis_categories_batch():
    out = compute_run_analysis(_batch_snapshot())
    assert out["page"] == "batch"
    assert "no_marks" not in out
    assert out["stats"] == {"files": 3, "models": 2, "questions": 2,
                            "cells": 12,
                            "marks": {"accept": 1, "reject": 2, "unsure": 0,
                                      "comments": 1}}
    kinds = [c["kind"] for c in out["categories"]]
    assert kinds[0] == "marks", "первичный сигнал — концентрация пометок"
    marks_cat = out["categories"][0]
    assert marks_cat["count"] == 2 and "№2" in marks_cat["title"]
    # комментарии — вербатим с координатами
    comments = next(c for c in out["categories"] if c["kind"] == "comments")
    assert comments["comments"][0]["comment"] == "не заметил"
    assert "a.txt" in comments["comments"][0]["coords"]
    # расхождение моделей по №2: 2 файла, действие «разметить», ячейки
    dis = next(c for c in out["categories"] if c["kind"] == "disagreement")
    assert dis["count"] == 2 and dis["action"] == "review"
    assert dis["cells"], "размечаемые ячейки приложены"
    t = dis["cells"][0]["target"]
    assert t["scope"] == "batch" and t["file"] and t["question"] == "q2"
    # близость к порогу: a.txt mB «да 80%» при условии P(да) < 70%
    thr = next(c for c in out["categories"] if c["kind"] == "threshold")
    assert thr["count"] == 1 and "70%" in thr["title"]
    # низкая уверенность <60%
    low = [c for c in out["categories"] if c["kind"] == "lowconf"]
    assert low and sum(c["count"] for c in low) >= 3
    # сырые расчёты — для details «Почему такой вывод»
    assert any("⚡" in line for line in out["raw"])


def test_run_analysis_no_marks_still_computes():
    snap = _batch_snapshot()
    del snap["reviewMarks"]
    out = compute_run_analysis(snap)
    assert out["no_marks"] is True
    kinds = {c["kind"] for c in out["categories"]}
    assert "disagreement" in kinds and "lowconf" in kinds, \
        "метрики по расхождениям/уверенности считаются и без разметки"
    assert "marks" not in kinds and "comments" not in kinds


def test_run_analysis_single_disagreement():
    out = compute_run_analysis(_single_snapshot())
    assert out["page"] == "single"
    dis = next(c for c in out["categories"] if c["kind"] == "disagreement")
    assert "№1" in dis["title"]
    # score-расхождение 1.9−1.2 < 1 — не считается
    assert sum(1 for c in out["categories"] if c["kind"] == "disagreement") == 1
    # lowconf: «нет · 52%»
    assert any(c["kind"] == "lowconf" for c in out["categories"])
    assert out["no_marks"] is True


def test_run_analysis_score_threshold():
    snap = _single_snapshot()
    snap["decision"] = {"outcomes": [
        {"label": "Топ", "rules": [{"conditions": [
            {"question": "q2", "op": "gte", "score": 1.5}]}]}]}
    out = compute_run_analysis(snap)
    thr = [c for c in out["categories"] if c["kind"] == "threshold"]
    # 27B: |1.2−1.5|=0.3 ≤ 0.5 — впритык; 35B: |1.9−1.5|=0.4 — тоже
    assert thr and thr[0]["count"] == 2
    assert "1.5" in thr[0]["title"]
    # фаза 2: далёкий порог — категории нет
    snap["decision"] = {"outcomes": [
        {"label": "Топ", "rules": [{"conditions": [
            {"question": "q2", "op": "gte", "score": 0.1}]}]}]}
    out = compute_run_analysis(snap)
    assert not [c for c in out["categories"] if c["kind"] == "threshold"]


# ------------------------------------------------------------------ очередь

def test_review_queue_empty_and_done():
    assert compute_review_queue({}) == {"empty": "no_results", "page": "single"}
    # всё размечено → done
    snap = _single_snapshot()
    snap["reviewMarks"] = {
        "totals": {"accept": 0, "reject": 1, "unsure": 0, "comments": 0},
        "items": ["вопрос №1 «Есть жалоба?» (вопрос целиком): ✗"],
        "targets": [{"sc": "single", "v": "reject", "q": 1, "qid": "q1"}],
    }
    out = compute_review_queue(snap)
    # вопрос №1 помечен целиком: disagreement-кандидат исключён;
    # остаётся lowconf «нет · 52%» у 35B
    assert all(c["questionN"] != 1 or c["prio"] != 3
               for c in out["candidates"])

    snap2 = _single_snapshot()
    snap2["singleResults"] = {"27B": [{"n": 1, "answer": "да · 95%"},
                                      {"n": 2, "answer": "1.00"}]}
    out2 = compute_review_queue(snap2)
    assert out2["done"] is True and out2["candidates"] == []


def test_review_queue_ordering_and_exclusion():
    out = compute_review_queue(_batch_snapshot())
    cands = out["candidates"]
    assert [c["prio"] for c in cands] == sorted(
        [c["prio"] for c in cands], reverse=True), "по убыванию ценности"
    assert cands[0]["reason"].startswith("⚡"), "расхождение — первое"
    assert out["total"] >= len(cands)
    # размеченная ячейка a.txt×№2×mA не предлагается; вместо неё — mB
    a_q2 = [c for c in cands if c["file"] == "a.txt" and c["questionN"] == 2]
    assert a_q2 and all(c["model"] != "mA" for c in a_q2)
    # цели — координаты revealTarget
    for c in cands:
        t = c["target"]
        assert t["scope"] == "batch" and t["file"] and t["question"] \
            and t["model"]


def test_review_queue_limit():
    out = compute_review_queue(_batch_snapshot(), limit=2)
    assert len(out["candidates"]) == 2
    assert out["total"] > 2
    # лимит зажат потолком 10
    out = compute_review_queue(_batch_snapshot(), limit=99)
    assert len(out["candidates"]) <= 10


def test_review_queue_single_targets():
    out = compute_review_queue(_single_snapshot())
    dis = next(c for c in out["candidates"] if c["prio"] == 3)
    # single-расхождение — вопрос целиком (без модели), причина по всем моделям
    assert dis["target"] == {"scope": "single", "question": "q1"}
    assert "«да»" in dis["reason"] and "«нет»" in dis["reason"]
    low = next(c for c in out["candidates"] if c["prio"] == 1)
    assert low["model"] == "35B"
    assert low["target"]["scope"] == "single"
    assert low["target"]["modelLabel"] == "35B"
