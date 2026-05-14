import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Clock, User } from 'lucide-react';
import { jobs, technicians } from '../../data/mock-data';
import { StatusBadge } from '../shared/StatusBadge';
import { useNavigate } from 'react-router';

const SERVICE_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const WEEK_DAYS = [
  { label: 'Mon', date: 'Mar 9',  key: 'Yesterday' },
  { label: 'Tue', date: 'Mar 10', key: 'Today' },
  { label: 'Wed', date: 'Mar 11', key: 'Tomorrow' },
  { label: 'Thu', date: 'Mar 12', key: 'Thursday' },
  { label: 'Fri', date: 'Mar 13', key: 'Friday' },
];

const TECH_COLORS: Record<string, string> = {
  'Carlos Reyes': 'bg-blue-100 text-blue-700 border-blue-200',
  'Marcus Webb':  'bg-green-100 text-green-700 border-green-200',
  'Sarah Lin':    'bg-violet-100 text-violet-700 border-violet-200',
};

export function SchedulePage() {
  const navigate = useNavigate();
  const [selectedDay, setSelectedDay] = useState('Today');
  const [view, setView] = useState<'week' | 'list'>('week');
  const [techFilter, setTechFilter] = useState<string>('All');

  const dayJobs = jobs.filter(j => {
    const matchDay = j.scheduledDate === selectedDay;
    const matchTech = techFilter === 'All' || j.assignedTech === techFilter;
    return matchDay && matchTech;
  });

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-slate-900">Schedule</h1>
        <button className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors">
          <Plus size={14} /> New job
        </button>
      </div>

      {/* Week nav */}
      <div className="flex items-center gap-2 mb-4">
        <button className="flex size-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
          <ChevronLeft size={15} />
        </button>
        <div className="flex-1 flex gap-1 overflow-x-auto scrollbar-none">
          {WEEK_DAYS.map(day => {
            const count = jobs.filter(j => j.scheduledDate === day.key).length;
            const isToday = day.key === 'Today';
            const isSelected = day.key === selectedDay;
            return (
              <button
                key={day.key}
                onClick={() => setSelectedDay(day.key)}
                className={`flex-1 min-w-[64px] flex flex-col items-center rounded-xl py-2.5 transition-all border ${
                  isSelected
                    ? 'bg-slate-900 border-slate-900 text-white'
                    : isToday
                    ? 'bg-blue-50 border-blue-100 text-blue-700'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="text-xs">{day.label}</span>
                <span className={`text-xs mt-0.5 ${isSelected ? 'text-slate-300' : 'text-slate-400'}`}>{day.date}</span>
                {count > 0 && (
                  <span className={`mt-1 flex size-4 items-center justify-center rounded-full text-xs ${
                    isSelected ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                  }`} style={{ fontSize: 9 }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button className="flex size-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Tech filter */}
      <div className="flex gap-2 mb-5 overflow-x-auto scrollbar-none">
        {['All', ...technicians.map(t => t.name)].map(name => {
          const t = technicians.find(x => x.name === name);
          const isSelected = techFilter === name;
          return (
            <button
              key={name}
              onClick={() => setTechFilter(name)}
              className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs border transition-colors ${
                isSelected
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {t && (
                <span
                  className="flex size-4 items-center justify-center rounded-full text-white shrink-0"
                  style={{ fontSize: 8, backgroundColor: t.color }}
                >
                  {t.initials}
                </span>
              )}
              {name === 'All' ? 'All techs' : name.split(' ')[0]}
            </button>
          );
        })}
      </div>

      {/* Day label */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-slate-700">
          {selectedDay === 'Today' ? "Today's schedule" : `${WEEK_DAYS.find(d => d.key === selectedDay)?.label ?? selectedDay}'s schedule`}
        </h3>
        <span className="text-xs text-slate-400">{dayJobs.length} job{dayJobs.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Jobs */}
      {dayJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-4xl mb-3">📅</span>
          <p className="text-sm text-slate-500 mb-1">Nothing scheduled</p>
          <p className="text-xs text-slate-400">Tap "New job" to schedule something</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {dayJobs
            .sort((a, b) => {
              const t = (s?: string) => {
                if (!s) return 99;
                const m = s.match(/(\d+):(\d+)\s*(AM|PM)/i);
                if (!m) return 99;
                let h = parseInt(m[1]);
                if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
                if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
                return h * 60 + parseInt(m[2]);
              };
              return t(a.scheduledTime) - t(b.scheduledTime);
            })
            .map(job => {
              const tech = technicians.find(t => t.name === job.assignedTech);
              const techStyle = job.assignedTech ? (TECH_COLORS[job.assignedTech] ?? '') : '';
              return (
                <button
                  key={job.id}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  className="flex gap-4 rounded-xl bg-white border border-slate-200 px-4 py-4 text-left hover:border-slate-300 hover:shadow-sm transition-all"
                >
                  {/* Time column */}
                  <div className="shrink-0 w-16 text-right">
                    {job.scheduledTime ? (
                      <>
                        <p className="text-sm text-slate-800">{job.scheduledTime.replace(' AM', 'am').replace(' PM', 'pm')}</p>
                        <p className="text-xs text-slate-400 mt-0.5">~2 hrs</p>
                      </>
                    ) : (
                      <p className="text-xs text-slate-400">TBD</p>
                    )}
                  </div>

                  {/* Divider */}
                  <div className="flex flex-col items-center gap-1">
                    <span className="size-2.5 rounded-full border-2 border-blue-500 bg-white mt-0.5 shrink-0" />
                    <span className="w-px flex-1 bg-slate-100" />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm text-slate-900">{job.customer}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{job.description}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-base">{SERVICE_ICON[job.serviceType]}</span>
                        <StatusBadge status={job.status} size="sm" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="flex items-center gap-1 text-xs text-slate-400">
                        <Clock size={11} /> {job.scheduledTime ?? 'Unscheduled'}
                      </span>
                      {tech && (
                        <span className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${techStyle}`}>
                          <span
                            className="flex size-4 items-center justify-center rounded-full text-white"
                            style={{ fontSize: 8, backgroundColor: tech.color }}
                          >
                            {tech.initials}
                          </span>
                          {tech.name.split(' ')[0]}
                        </span>
                      )}
                      {!job.assignedTech && (
                        <span className="flex items-center gap-1 text-xs text-amber-600">
                          <User size={11} /> Unassigned
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
        </div>
      )}

      {/* Technician availability summary */}
      <div className="mt-6 rounded-xl bg-white border border-slate-200 px-4 py-4">
        <h4 className="text-slate-700 mb-3">Team today</h4>
        <div className="flex flex-col gap-3">
          {technicians.map(tech => {
            const techJobs = jobs.filter(j => j.assignedTech === tech.name && j.scheduledDate === 'Today');
            return (
              <div key={tech.id} className="flex items-center gap-3">
                <span
                  className="flex size-7 items-center justify-center rounded-full text-white text-xs shrink-0"
                  style={{ backgroundColor: tech.color }}
                >
                  {tech.initials}
                </span>
                <div className="flex-1">
                  <p className="text-sm text-slate-800">{tech.name}</p>
                  <p className="text-xs text-slate-400">{techJobs.length} job{techJobs.length !== 1 ? 's' : ''} today</p>
                </div>
                <div className="flex gap-1">
                  {techJobs.map(j => (
                    <span key={j.id} className="text-base" title={j.customer}>{SERVICE_ICON[j.serviceType]}</span>
                  ))}
                  {techJobs.length === 0 && <span className="text-xs text-slate-400">Available</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </div>
  );
}