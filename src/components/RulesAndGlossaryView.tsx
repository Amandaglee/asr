import React from 'react';
import { CheckCircle2 } from 'lucide-react';

interface RulesAndGlossaryViewProps {
  customRules: string;
  onChangeCustomRules: (val: string) => void;
}

const CORE_PRINCIPLES = [
  {
    index: '01',
    title: '绝对忠于音频原声（所听即所得）',
    desc: '音频发出什么声音就保留什么字词，一字不差还原真实发音，严禁进行书面化润色、语法纠错或脑补。',
  },
  {
    index: '02',
    title: '字词精修与口误完整保留',
    desc: '修正同音错字（如“定螺丝”→“钉螺丝”）；补全吞字漏词与真实语气词；口误与改口（如先说“整个”后改口说“穿个”）必须完整保留前后全部发音，绝不删除口误词。',
  },
  {
    index: '03',
    title: '说话人角色（role）核对',
    desc: '结合声纹特征与对话轮次核对每条 utterance_id 的 role（如 user / assistant），发现声纹与角色不匹配立即修正。',
  },
  {
    index: '04',
    title: '原 VAD 时间轴默认锁定（严禁顺延）',
    desc: '输入 JSON 的起止时间通常来自精准的语音活动检测（VAD），默认完全保留原 start / end 不做改动，彻底杜绝 AI 顺延导致的时间轴错乱；如需调整个别错位语句，可切换为“仅微调明显错位”或直接在行内手工微调。',
  },
];

export const RulesAndGlossaryView: React.FC<RulesAndGlossaryViewProps> = ({
  customRules,
  onChangeCustomRules,
}) => {
  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 font-display">
          ASR 质检校准规范与补充词库
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
          以下零容错准则已固化为模型系统指令（System Instruction）及结构化输出约束，每次音频核对均严格执行。
        </p>
      </div>

      {/* Core Principles Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {CORE_PRINCIPLES.map((item) => (
          <div key={item.index} className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex items-baseline gap-2.5">
              <span className="text-xs font-mono font-semibold text-blue-700 tabular-nums">
                {item.index}.
              </span>
              <h2 className="text-sm font-semibold text-slate-900">{item.title}</h2>
            </div>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">{item.desc}</p>
          </div>
        ))}
      </div>

      {/* Batch & Anti-Omission Rules */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">批量输出与防省略约束</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-slate-600">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>每组音频与 JSON 独立完整输出全部 transcripts 数组，严禁使用省略占位符。</span>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>严格保持输入字段命名、数据类型与嵌套层级不变，仅修正问题字段值。</span>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>导出时严格保持原 JSON 结构（session_id / duration_sec / transcripts），不附带 results 或 summary 包装字段。</span>
          </div>
        </div>
      </div>

      {/* Supplementary Domain Glossary */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">补充业务词库与说话人约定（可选）</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              在此填入特定业务专有名词、易混同音词或说话人音色特征，校准请求时将附加给音频核对引擎。
            </p>
          </div>
          {customRules.trim() && (
            <button
              type="button"
              onClick={() => onChangeCustomRules('')}
              className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              清空补充规则
            </button>
          )}
        </div>
        <textarea
          rows={5}
          value={customRules}
          onChange={(e) => onChangeCustomRules(e.target.value)}
          placeholder="例如：&#10;- 常见易错词：脚踏挡板（非“脚打烫法”）、钉螺丝（非“定螺丝”）、膨胀螺丝&#10;- 说话人区分：user 为男声客服咨询者，assistant 为女声安装指导专员"
          className="w-full px-3.5 py-2.5 text-sm text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
      </div>
    </div>
  );
};
