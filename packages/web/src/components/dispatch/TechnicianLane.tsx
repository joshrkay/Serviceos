import React from 'react';
import { AppointmentCard, AppointmentCardData } from './AppointmentCard';
import type { FeasibilityResult } from './feasibility-types';

export interface TechnicianInfo {
  id: string;
  name: string;
}

export interface DragPreview {
  targetTechnicianId: string;
  preview: FeasibilityResult | null;
}

export interface TechnicianLaneProps {
  technician: TechnicianInfo;
  appointments: AppointmentCardData[];
  onDragStart?: (e: React.DragEvent, appointmentId: string) => void;
  isDragOver?: boolean;
  activeDropIndex?: number | null;
  onDragOverGap?: (insertIndex: number, e: React.DragEvent) => void;
  onDragLeaveGap?: (e: React.DragEvent) => void;
  onDropGap?: (insertIndex: number, e: React.DragEvent) => void;
  onReorderWithinLane?: (appointmentId: string, fromIndex: number, toIndex: number) => void;
  conflictIds?: ReadonlySet<string>;
  dragPreview?: DragPreview | null;
  currentUserId?: string;
  onAddCrew?: (appointmentId: string) => void;
  onRemoveCoAssignee?: (appointmentId: string, technicianId: string) => void;
}

function dropZoneStateClass(dragPreview: DragPreview | null | undefined, technicianId: string): string {
  if (!dragPreview || dragPreview.targetTechnicianId !== technicianId || !dragPreview.preview) {
    return 'drop-zone--idle';
  }
  const { preview } = dragPreview;
  if (!preview.feasible) return 'drop-zone--blocking';
  if (preview.warnings.length > 0) return 'drop-zone--warning';
  return 'drop-zone--ok';
}

function LaneGap({
  insertIndex,
  isActive,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  insertIndex: number;
  isActive: boolean;
  onDragOver?: (insertIndex: number, e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (insertIndex: number, e: React.DragEvent) => void;
}) {
  return (
    <div
      className={`technician-lane__gap min-h-[8px] ${isActive ? 'technician-lane__gap--active' : ''}`}
      data-testid="technician-lane-gap"
      data-drop-index={insertIndex}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDragOver?.(insertIndex, e);
      }}
      onDragLeave={(e) => onDragLeave?.(e)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop?.(insertIndex, e);
      }}
    />
  );
}

export function TechnicianLane({
  technician,
  appointments,
  onDragStart,
  isDragOver = false,
  activeDropIndex = null,
  onDragOverGap,
  onDragLeaveGap,
  onDropGap,
  onReorderWithinLane,
  conflictIds,
  dragPreview,
  currentUserId,
  onAddCrew,
  onRemoveCoAssignee,
}: TechnicianLaneProps) {
  const sortedAppointments = [...appointments].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );

  const dropZoneClass = dropZoneStateClass(dragPreview, technician.id);

  return (
    <div
      className={`technician-lane ${isDragOver ? 'technician-lane--drag-over' : ''} ${dropZoneClass}`}
      data-testid="technician-lane"
      data-technician-id={technician.id}
      data-drop-zone-state={dropZoneClass}
    >
      <div className="technician-lane__header" data-testid="technician-lane-header">
        <span className="technician-lane__name">{technician.name}</span>
        <span className="technician-lane__count" data-testid="technician-lane-count">
          {appointments.length}
        </span>
      </div>

      <div className="technician-lane__appointments" data-testid="technician-lane-appointments">
        {sortedAppointments.length === 0 ? (
          <>
            <LaneGap
              insertIndex={0}
              isActive={activeDropIndex === 0}
              onDragOver={onDragOverGap}
              onDragLeave={onDragLeaveGap}
              onDrop={onDropGap}
            />
            <div className="technician-lane__empty" data-testid="technician-lane-empty">
              No appointments
            </div>
          </>
        ) : (
          sortedAppointments.map((appointment, index) => (
            <React.Fragment key={appointment.id}>
              <LaneGap
                insertIndex={index}
                isActive={activeDropIndex === index}
                onDragOver={onDragOverGap}
                onDragLeave={onDragLeaveGap}
                onDrop={onDropGap}
              />
              <div
                className="technician-lane__appointment-row"
                data-testid="technician-lane-appointment-row"
              >
                <AppointmentCard
                  appointment={appointment}
                  draggable={true}
                  onDragStart={onDragStart}
                  hasConflict={conflictIds?.has(appointment.id) ?? false}
                  currentUserId={currentUserId}
                  onAddCrew={onAddCrew}
                  onRemoveCoAssignee={onRemoveCoAssignee}
                />
                {onReorderWithinLane && (
                  <div
                    className="technician-lane__reorder-controls"
                    data-testid="lane-reorder-controls"
                  >
                    <button
                      type="button"
                      data-testid="lane-reorder-up"
                      aria-label={`Move ${appointment.jobSummary ?? 'appointment'} earlier`}
                      disabled={index === 0}
                      onClick={() =>
                        onReorderWithinLane(appointment.id, index, Math.max(0, index - 1))
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      data-testid="lane-reorder-down"
                      aria-label={`Move ${appointment.jobSummary ?? 'appointment'} later`}
                      disabled={index === sortedAppointments.length - 1}
                      onClick={() =>
                        onReorderWithinLane(
                          appointment.id,
                          index,
                          Math.min(sortedAppointments.length - 1, index + 1),
                        )
                      }
                    >
                      ↓
                    </button>
                  </div>
                )}
              </div>
            </React.Fragment>
          ))
        )}
        {sortedAppointments.length > 0 && (
          <LaneGap
            insertIndex={sortedAppointments.length}
            isActive={activeDropIndex === sortedAppointments.length}
            onDragOver={onDragOverGap}
            onDragLeave={onDragLeaveGap}
            onDrop={onDropGap}
          />
        )}
      </div>
    </div>
  );
}
