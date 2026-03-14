import React, { useState, useCallback } from 'react';
import { DateNavigation } from '../../components/dispatch/DateNavigation';
import { SummaryStrip } from '../../components/dispatch/SummaryStrip';
import { DispatchFilters, DispatchFilterValues } from '../../components/dispatch/DispatchFilters';
import { UnassignedQueue } from '../../components/dispatch/UnassignedQueue';
import { TechnicianLane } from '../../components/dispatch/TechnicianLane';
import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import { AppointmentCardData } from '../../components/dispatch/AppointmentCard';

export function DispatchBoard() {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [filters, setFilters] = useState<DispatchFilterValues>({});
  const { data, isLoading, error, refetch } = useDispatchBoard(selectedDate);

  const handleDateChange = useCallback((date: Date) => {
    setSelectedDate(date);
  }, []);

  const handleFilterChange = useCallback((newFilters: DispatchFilterValues) => {
    setFilters(newFilters);
  }, []);

  const filteredLanes = data?.technicianLanes.filter((lane) => {
    if (filters.technicianIds && filters.technicianIds.length > 0) {
      return filters.technicianIds.includes(lane.technicianId);
    }
    return true;
  }) ?? [];

  const filterAppointmentsByStatus = (appointments: AppointmentCardData[]) => {
    if (!filters.status) return appointments;
    return appointments.filter((a) => a.status === filters.status);
  };

  const technicians = data?.technicianLanes.map((lane) => ({
    id: lane.technicianId,
    name: lane.technicianName,
  })) ?? [];

  if (error) {
    return (
      <div className="dispatch-board dispatch-board--error" data-testid="dispatch-board">
        <div className="dispatch-board__error" data-testid="dispatch-board-error">
          <p>{error}</p>
          <button onClick={refetch}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dispatch-board" data-testid="dispatch-board">
      <div className="dispatch-board__header">
        <h1>Dispatch Board</h1>
        <DateNavigation selectedDate={selectedDate} onDateChange={handleDateChange} />
      </div>

      {data?.summary && (
        <SummaryStrip summary={data.summary} />
      )}

      <DispatchFilters
        technicians={technicians}
        activeFilters={filters}
        onFilterChange={handleFilterChange}
      />

      {isLoading ? (
        <div className="dispatch-board__loading" data-testid="dispatch-board-loading">
          Loading dispatch board...
        </div>
      ) : (
        <div className="dispatch-board__content">
          <div className="dispatch-board__sidebar">
            <UnassignedQueue
              appointments={filterAppointmentsByStatus(data?.unassignedAppointments ?? [])}
            />
          </div>

          <div className="dispatch-board__lanes" data-testid="dispatch-board-lanes">
            {filteredLanes.map((lane) => (
              <TechnicianLane
                key={lane.technicianId}
                technician={{
                  id: lane.technicianId,
                  name: lane.technicianName,
                }}
                appointments={filterAppointmentsByStatus(lane.appointments)}
              />
            ))}
            {filteredLanes.length === 0 && !isLoading && (
              <div className="dispatch-board__empty" data-testid="dispatch-board-empty">
                No technician lanes to display
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
