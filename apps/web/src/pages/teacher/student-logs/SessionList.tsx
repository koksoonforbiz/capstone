import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { BarChart2, Layers } from 'lucide-react';

interface Session {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSecs: number | null;
  liveEventCount?: number;
  courseId?: string;
  userId?: string;
  summary: {
    totalEvents: number;
    totalActiveTimeSecs: number;
    questionsAnswered: number;
    interventionsTriggered: number;
  } | null;
}

interface Props {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** When provided, renders an "Episodes" link per session for the
   *  retrospective tracing teacher portal (prompt_retro Stage 4+). */
  studentId?: string;
}

export function SessionList({ sessions, selectedId, onSelect, studentId }: Props) {
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {sessions.map((s) => (
        <li key={s.id}>
          <button
            onClick={() => onSelect(s.id)}
            className={`w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
              selectedId === s.id
                ? 'bg-indigo-50 dark:bg-indigo-900/20 border-l-2 border-indigo-500'
                : ''
            }`}
          >
            <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
              {format(new Date(s.startedAt), 'MMM d, yyyy \u2014 HH:mm')}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {s.durationSecs ? `${Math.round(s.durationSecs / 60)} min` : 'In progress'} ·{' '}
              {s.summary?.totalEvents ?? s.liveEventCount ?? 0} events
            </p>
            {s.summary && (
              <div className="flex gap-2 mt-1.5 flex-wrap">
                <Chip label={`${s.summary.questionsAnswered} Q`} color="blue" />
                <Chip label={`${s.summary.interventionsTriggered} int.`} color="purple" />
              </div>
            )}
            <div className="flex items-center gap-3 mt-1.5">
              <Link
                to={`/dashboard/sessions/${s.id}/timeline`}
                className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                onClick={(e) => e.stopPropagation()}
              >
                <BarChart2 size={14} />
                Timeline
              </Link>
              {s.courseId && studentId && (
                <Link
                  to={`/teacher/research/courses/${s.courseId}/students/${studentId}/episodes`}
                  className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-300"
                  onClick={(e) => e.stopPropagation()}
                  title="Open the retrospective tracing episode picker for this student in this course"
                >
                  <Layers size={14} />
                  Episodes
                </Link>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Chip({ label, color }: { label: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    purple: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    green: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors[color] ?? ''}`}>
      {label}
    </span>
  );
}
