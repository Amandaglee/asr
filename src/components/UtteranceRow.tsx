import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Edit3, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Utterance } from '../types/asr';
import { computeCharDiff, formatDelta, formatSec } from '../utils/diff';
import { areUtteranceExtraFieldsEqual } from '../utils/validation';

interface UtteranceRowProps {
  utterance: Utterance;
  referenceUtterance?: Utterance;
  durationSec: number;
  extraColumns: string[];
  availableRoles: string[];
  isActive: boolean;
  isPlaying: boolean;
  autoEdit?: boolean;
  onAutoEditConsumed?: () => void;
  onPlaySegment: (u: Utterance) => void;
  onSelect: (id: number) => void;
  onUpdate: (updated: Utterance) => void;
  onRevert: (id: number) => void;
  onInsertAfter: (id: number) => void;
  onDelete: (id: number) => void;
  onAddCustomRole: (role: string) => void;
}

export const UtteranceRow: React.FC<UtteranceRowProps> = ({
  utterance,
  referenceUtterance,
  durationSec,
  extraColumns,
  availableRoles,
  isActive,
  isPlaying,
  autoEdit,
  onAutoEditConsumed,
  onPlaySegment,
  onSelect,
  onUpdate,
  onRevert,
  onInsertAfter,
  onDelete,
  onAddCustomRole,
}) => {
  const [isEditingText, setIsEditingText] = useState(false);
  const [draftText, setDraftText] = useState(utterance.text);
  const [isAddingRole, setIsAddingRole] = useState(false);
  const [draftRole, setDraftRole] = useState('');

  useEffect(() => {
    if (autoEdit) {
      setDraftText(utterance.text);
      setIsEditingText(true);
      onAutoEditConsumed?.();
    }
  }, [autoEdit, utterance.text, onAutoEditConsumed]);

  const refText = referenceUtterance?.text ?? utterance.text;
  const textChanged = referenceUtterance ? utterance.text !== referenceUtterance.text : false;
  const roleChanged = referenceUtterance ? utterance.role !== referenceUtterance.role : false;
  const startDelta = referenceUtterance ? utterance.start - referenceUtterance.start : 0;
  const endDelta = referenceUtterance ? utterance.end - referenceUtterance.end : 0;
  const timeChanged = Math.abs(startDelta) >= 0.01 || Math.abs(endDelta) >= 0.01;
  const extraChanged = referenceUtterance
    ? !areUtteranceExtraFieldsEqual(utterance, referenceUtterance, extraColumns)
    : false;
  const anyChanged =
    textChanged || roleChanged || timeChanged || extraChanged || !referenceUtterance;

  const roleOptions = useMemo(() => {
    const set = new Set<string>(availableRoles);
    if (utterance.role?.trim()) set.add(utterance.role.trim());
    if (referenceUtterance?.role?.trim()) set.add(referenceUtterance.role.trim());
    return Array.from(set);
  }, [availableRoles, utterance.role, referenceUtterance?.role]);

  const diffSegments = useMemo(
    () => computeCharDiff(refText, utterance.text),
    [refText, utterance.text]
  );

  const outOfBounds = utterance.start < 0 || utterance.end > durationSec + 0.05 || utterance.start >= utterance.end;

  const commitText = () => {
    setIsEditingText(false);
    if (draftText !== utterance.text) {
      onUpdate({ ...utterance, text: draftText });
    }
  };

  const commitCustomRole = () => {
    const trimmed = draftRole.trim();
    setIsAddingRole(false);
    setDraftRole('');
    if (trimmed) {
      onAddCustomRole(trimmed);
      onUpdate({ ...utterance, role: trimmed });
    }
  };

  return (
    <tr
      onClick={() => onSelect(utterance.utterance_id)}
      className={`group border-b border-slate-200 transition-colors align-top ${
        isActive ? 'bg-blue-50/60' : 'hover:bg-slate-50/80 bg-white'
      }`}
    >
      {/* ID + Play */}
      <td className="py-3 pl-4 pr-2 w-24 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPlaySegment(utterance);
            }}
            title={`播放 #${utterance.utterance_id} (${formatSec(utterance.start)} - ${formatSec(utterance.end)})`}
            className={`w-7 h-7 inline-flex items-center justify-center rounded-md border transition-colors cursor-pointer shrink-0 ${
              isActive && isPlaying
                ? 'bg-blue-700 border-blue-700 text-white'
                : 'bg-white border-slate-200 text-slate-700 hover:border-blue-400 hover:text-blue-700'
            }`}
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono tabular-nums text-xs font-semibold text-slate-700">
            #{utterance.utterance_id}
          </span>
        </div>
      </td>

      {/* Speaker Role */}
      <td className="py-3 px-3 w-36 whitespace-nowrap">
        <div className="flex flex-col gap-1">
          {isAddingRole ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                autoFocus
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCustomRole();
                  } else if (e.key === 'Escape') {
                    setIsAddingRole(false);
                    setDraftRole('');
                  }
                }}
                onBlur={commitCustomRole}
                placeholder="输入角色名..."
                className="w-24 px-2 py-1 text-xs font-mono bg-white border border-blue-400 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
          ) : (
            <select
              aria-label={`Utterance ${utterance.utterance_id} 说话人角色`}
              value={utterance.role}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setDraftRole('');
                  setIsAddingRole(true);
                  return;
                }
                onUpdate({ ...utterance, role: e.target.value });
              }}
              className={`text-xs font-mono px-2 py-1 rounded border bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${
                roleChanged ? 'border-amber-400 text-amber-900 font-medium' : 'border-slate-200 text-slate-800'
              }`}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="__custom__">+ 自定义角色...</option>
            </select>
          )}
          {roleChanged && referenceUtterance && (
            <span className="text-[11px] font-mono text-amber-700 inline-flex items-center gap-1">
              <span>{referenceUtterance.role}</span>
              <ArrowRight className="w-2.5 h-2.5" />
              <span className="font-semibold">{utterance.role}</span>
            </span>
          )}
        </div>
      </td>

      {/* Dynamic Extra JSON Columns (e.g. key, speaker, etc.) */}
      {extraColumns.map((col) => {
        const rawVal = utterance[col];
        const refVal = referenceUtterance?.[col];
        const cellChanged = referenceUtterance
          ? JSON.stringify(rawVal) !== JSON.stringify(refVal)
          : false;
        const isComplex = rawVal !== null && typeof rawVal === 'object';
        const displayStr =
          rawVal === undefined || rawVal === null
            ? ''
            : isComplex
              ? JSON.stringify(rawVal)
              : String(rawVal);

        return (
          <td key={col} className="py-3 px-2.5 whitespace-nowrap">
            {isComplex ? (
              <span
                title={displayStr}
                className="inline-block max-w-[140px] truncate text-xs font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1"
              >
                {displayStr}
              </span>
            ) : (
              <input
                type="text"
                aria-label={`#${utterance.utterance_id} ${col}`}
                value={displayStr}
                placeholder="—"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const nextStr = e.target.value;
                  let nextVal: unknown = nextStr;
                  if (typeof rawVal === 'number' && nextStr.trim() !== '' && Number.isFinite(Number(nextStr))) {
                    nextVal = Number(nextStr);
                  } else if (typeof rawVal === 'boolean') {
                    if (nextStr.toLowerCase() === 'true') nextVal = true;
                    else if (nextStr.toLowerCase() === 'false') nextVal = false;
                  }
                  onUpdate({ ...utterance, [col]: nextVal });
                }}
                className={`min-w-[64px] w-24 max-w-[140px] px-2 py-1 text-xs font-mono tabular-nums rounded border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${
                  cellChanged ? 'border-amber-400 text-amber-900 font-medium' : 'border-slate-200 text-slate-800'
                }`}
              />
            )}
          </td>
        );
      })}

      {/* Timestamps + Cascade Shift */}
      <td className="py-3 px-3 w-52 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            step="0.05"
            min="0"
            max={durationSec}
            aria-label={`#${utterance.utterance_id} 起始时间`}
            value={utterance.start}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (Number.isFinite(val)) {
                onUpdate({ ...utterance, start: Number(val.toFixed(2)) });
              }
            }}
            className={`w-20 px-2 py-1 text-xs font-mono tabular-nums rounded border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${
              outOfBounds ? 'border-rose-400 text-rose-700' : 'border-slate-200 text-slate-800'
            }`}
          />
          <span className="text-slate-400 text-xs">–</span>
          <input
            type="number"
            step="0.05"
            min="0"
            max={durationSec}
            aria-label={`#${utterance.utterance_id} 结束时间`}
            value={utterance.end}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (Number.isFinite(val)) {
                onUpdate({ ...utterance, end: Number(val.toFixed(2)) });
              }
            }}
            className={`w-20 px-2 py-1 text-xs font-mono tabular-nums rounded border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${
              outOfBounds ? 'border-rose-400 text-rose-700' : 'border-slate-200 text-slate-800'
            }`}
          />
        </div>

        <div className="mt-1 flex items-center gap-2 text-[11px] font-mono tabular-nums">
          {timeChanged ? (
            <span className="text-blue-700">
              偏移 {formatDelta(startDelta)} / {formatDelta(endDelta)}
            </span>
          ) : (
            <span className="text-slate-400">
              时长 {formatSec(Math.max(0, utterance.end - utterance.start))}
            </span>
          )}
        </div>
      </td>

      {/* Verbatim Text Diff & Editor */}
      <td className="py-3 px-3 min-w-[320px]">
        {isEditingText ? (
          <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
            <textarea
              rows={2}
              autoFocus
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitText();
                } else if (e.key === 'Escape') {
                  setDraftText(utterance.text);
                  setIsEditingText(false);
                }
              }}
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-blue-400 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={commitText}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-700 text-white rounded hover:bg-blue-800 cursor-pointer"
              >
                <Check className="w-3 h-3" />
                <span>保存文本</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftText(utterance.text);
                  setIsEditingText(false);
                }}
                className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div
              onDoubleClick={(e) => {
                e.stopPropagation();
                setDraftText(utterance.text);
                setIsEditingText(true);
              }}
              className="text-sm leading-relaxed text-slate-900 flex-1"
            >
              {!referenceUtterance ? (
                <span className="bg-emerald-50 text-emerald-900 px-1 rounded">
                  {utterance.text}
                </span>
              ) : textChanged ? (
                <span>
                  {diffSegments.map((seg, idx) => {
                    if (seg.type === 'equal') {
                      return <span key={idx}>{seg.value}</span>;
                    }
                    if (seg.type === 'delete') {
                      return (
                        <del
                          key={idx}
                          className="bg-rose-50 text-rose-700 line-through decoration-rose-400 px-0.5 mx-0.5 rounded-xs"
                        >
                          {seg.value}
                        </del>
                      );
                    }
                    return (
                      <ins
                        key={idx}
                        className="bg-emerald-50 text-emerald-800 no-underline border-b-2 border-emerald-500 px-0.5 mx-0.5 font-medium rounded-xs"
                      >
                        {seg.value}
                      </ins>
                    );
                  })}
                </span>
              ) : (
                <span className="text-slate-800">{utterance.text}</span>
              )}
            </div>

            <div className="flex items-center gap-0.5 shrink-0 opacity-85 group-hover:opacity-100">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDraftText(utterance.text);
                  setIsEditingText(true);
                }}
                title="手工修订转写文本"
                className="p-1.5 text-slate-500 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onInsertAfter(utterance.utterance_id);
                }}
                title="在此句下方插入新语句"
                className="p-1.5 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              {anyChanged && referenceUtterance && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRevert(utterance.utterance_id);
                  }}
                  title="还原为参考 JSON 原始值"
                  className="p-1.5 text-slate-500 hover:text-amber-700 hover:bg-amber-50 rounded transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(utterance.utterance_id);
                }}
                title="删除此条语句"
                className="p-1.5 text-slate-400 hover:text-rose-700 hover:bg-rose-50 rounded transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </td>

      {/* Status text (unboxed, semantic + explicit label) */}
      <td className="py-3 pl-2 pr-4 w-24 text-right whitespace-nowrap">
        {!referenceUtterance ? (
          <span className="text-xs font-medium text-emerald-700">新增补全</span>
        ) : anyChanged ? (
          <span className="text-xs font-medium text-blue-700">已校准</span>
        ) : (
          <span className="text-xs text-slate-400">一致</span>
        )}
      </td>
    </tr>
  );
};
