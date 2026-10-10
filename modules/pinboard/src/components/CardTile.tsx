import { ArrowRight, CalendarDays, GripVertical } from 'lucide-react';
import type { Card, Column } from '../types';
export function CardTile({
  card,
  columns,
  disabled,
  onEdit,
  onMove,
}: {
  card: Card;
  columns: Column[];
  disabled: boolean;
  onEdit: () => void;
  onMove: (columnId: string) => void;
}) {
  const overdue = Boolean(
    card.dueDate && card.dueDate < new Date().toLocaleDateString('en-CA'),
  );
  return (
    <article
      className={`task-card priority-${card.priority}`}
      draggable={!disabled}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/pinboard-card', card.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button
        className="card-content"
        onClick={onEdit}
        aria-label={`Edit ${card.title}`}
        disabled={disabled}
      >
        <div className="card-top">
          <span className={`priority priority-${card.priority}`}>
            <span />
            {card.priority} priority
          </span>
          <GripVertical className="drag-grip" size={15} />
        </div>
        <h3>{card.title}</h3>
        {card.description && (
          <p className="card-description">{card.description}</p>
        )}
        {card.labels.length > 0 && (
          <div className="labels">
            {card.labels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        )}
        {(card.assignee || card.dueDate) && (
          <div className="card-meta">
            {card.assignee && (
              <span className="person">
                <span className="avatar">
                  {card.assignee.slice(0, 1).toUpperCase()}
                </span>
                {card.assignee}
              </span>
            )}
            {card.dueDate && (
              <span className={overdue ? 'due overdue' : 'due'}>
                <CalendarDays size={13} />
                {new Date(`${card.dueDate}T12:00:00`).toLocaleDateString(
                  undefined,
                  { month: 'short', day: 'numeric' },
                )}
              </span>
            )}
          </div>
        )}
      </button>
      <div className="card-move">
        <ArrowRight size={13} />
        <label className="sr-only" htmlFor={`move-${card.id}`}>
          Move {card.title} to
        </label>
        <select
          id={`move-${card.id}`}
          value={card.columnId}
          disabled={disabled}
          onChange={(event) => onMove(event.target.value)}
        >
          {columns.map((column) => (
            <option value={column.id} key={column.id}>
              {column.title}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}
