import { calendarCountSql, calendarNthSql } from './task-calendar.sql.js';
export const itemConditionsSql = {
    overdue: `status='PENDING' AND (deadline_date<$3::date OR (deadline_time IS NOT NULL AND (deadline_date::text || ' ' || deadline_time)::timestamp < ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')))`,
    today: `status='PENDING' AND deadline_date=$3::date`,
    urgent: `status='PENDING' AND urgency='URGENT'`,
    upcoming: `status='PENDING' AND deadline_date>$3::date`,
    noDeadline: `status='PENDING' AND deadline_date IS NULL`,
};
export const itemSortSql = `concat(CASE WHEN ${itemConditionsSql.overdue} THEN '0' WHEN ${itemConditionsSql.today} THEN '1' WHEN deadline_date IS NOT NULL THEN '2' ELSE '3' END,':',CASE urgency WHEN 'URGENT' THEN '0' WHEN 'HIGH' THEN '1' WHEN 'NORMAL' THEN '2' ELSE '3' END,':',coalesce(deadline_date::text,'9999-12-31'),':',coalesce(deadline_time,'23:59'),':',identity)`;
const jsonTask = `jsonb_build_object('id',t.id,'spaceId',t.space_id,'description',t.description,'creator',jsonb_build_object('personId',t.creator_person_id,'memberId',t.creator_member_id),'assignee',CASE WHEN t.assignee_person_id IS NULL THEN NULL ELSE jsonb_build_object('personId',t.assignee_person_id,'memberId',t.assignee_member_id) END,'deadline',CASE WHEN t.deadline_date IS NULL THEN NULL ELSE jsonb_build_object('date',t.deadline_date,'time',t.deadline_time) END,'urgency',t.urgency,'status',t.status,'version',t.version,'createdAt',to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'completion',t.completion,'shoppingListId',t.shopping_list_id,'kind','ONE_OFF')`;
export const routineSourceSql = `WITH rules AS MATERIALIZED (
    SELECT r.*,r.snapshot->'rule' rule,r.snapshot->>'urgency' urgency,r.snapshot->'deadline' <> 'null'::jsonb has_deadline,r.snapshot->'deadline'->>'time' deadline_time,
    greatest(r.starts_on,coalesce($8::date,r.starts_on)) lo,
    least(coalesce(r.ends_on,'9999-12-31'::date),coalesce(r.cancelled_on,'9999-12-31'::date),coalesce($9::date,CASE WHEN r.snapshot->'deadline'='null'::jsonb THEN $3::date ELSE $3::date+365 END)) hi
    FROM routine_task_recurrences r WHERE r.space_id=$1 AND ($6='ALL' OR r.snapshot->'assignee'->>'personId'=$2) AND $5 IN ('PENDING','ALL')
), ranges AS MATERIALIZED (
    SELECT r.*,
    greatest(lo,CASE WHEN $7='TODAY' THEN $3::date WHEN $7='UPCOMING' THEN $3::date+1 ELSE lo END) match_lo,
    least(hi,CASE WHEN $7 IN ('TODAY','OVERDUE') OR ($7 IN ('ATTENTION','NEEDS_ATTENTION') AND urgency<>'URGENT') THEN CASE WHEN $7 IN ('OVERDUE','NEEDS_ATTENTION') AND (deadline_time IS NULL OR ($3::date::text || ' ' || deadline_time)::timestamp >= ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')) THEN $3::date-1 ELSE $3::date END ELSE hi END) match_hi
    FROM rules r WHERE ($7::text IS NULL OR $7='URGENT' AND urgency='URGENT' OR $7 IN ('TODAY','OVERDUE','UPCOMING') AND has_deadline OR $7='NO_DEADLINE' AND NOT has_deadline OR $7 IN ('ATTENTION','NEEDS_ATTENTION') AND (has_deadline OR urgency='URGENT'))
), materialized AS MATERIALIZED (
    SELECT o.snapshot || jsonb_build_object('kind','OCCURRENCE','materialized',true,'recurrenceVersion',r.version) item,o.recurrence_id::text || '/' || o.scheduled_date::text identity
    FROM routine_task_occurrences o JOIN routine_task_recurrences r ON r.id=o.recurrence_id AND r.space_id=o.space_id WHERE o.space_id=$1
), facts AS MATERIALIZED (
    SELECT ${jsonTask} item,t.id::text identity FROM routine_tasks t WHERE t.space_id=$1
    UNION ALL SELECT * FROM materialized
), fact_values AS MATERIALIZED (
    SELECT item,identity,item->>'status' status,item->>'urgency' urgency,(item->'deadline'->>'date')::date deadline_date,item->'deadline'->>'time' deadline_time,item->>'scheduledDate' scheduled_date
    FROM facts WHERE ($6='ALL' OR item->'assignee'->>'personId'=$2) AND ($5='ALL' OR item->>'status'=$5)
    AND ($8::date IS NULL OR coalesce((item->>'scheduledDate')::date,(item->'deadline'->>'date')::date)>=$8::date) AND ($9::date IS NULL OR coalesce((item->>'scheduledDate')::date,(item->'deadline'->>'date')::date)<=$9::date)
), filtered_facts AS MATERIALIZED (
    SELECT * FROM fact_values WHERE $7::text IS NULL OR CASE $7 WHEN 'TODAY' THEN ${itemConditionsSql.today} WHEN 'OVERDUE' THEN ${itemConditionsSql.overdue} WHEN 'URGENT' THEN ${itemConditionsSql.urgent} WHEN 'UPCOMING' THEN ${itemConditionsSql.upcoming} WHEN 'NO_DEADLINE' THEN ${itemConditionsSql.noDeadline} WHEN 'ATTENTION' THEN (${itemConditionsSql.overdue}) OR (${itemConditionsSql.today}) OR (${itemConditionsSql.urgent}) WHEN 'NEEDS_ATTENTION' THEN (${itemConditionsSql.overdue}) OR (${itemConditionsSql.urgent}) END
)`;
const overdueHigh = `CASE WHEN deadline_time IS NOT NULL AND ($3::date::text || ' ' || deadline_time)::timestamp < ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo') THEN $3::date ELSE $3::date-1 END`;
export const routineCountsSql = `${routineSourceSql}, existing AS (
    SELECT r.id,count(*)::int total,count(*) FILTER (WHERE o.scheduled_date=$3::date)::int today,count(*) FILTER (WHERE o.scheduled_date<=${overdueHigh})::int overdue,count(*) FILTER (WHERE o.scheduled_date>$3::date)::int upcoming
    FROM ranges r JOIN routine_task_occurrences o ON o.recurrence_id=r.id AND o.scheduled_date BETWEEN r.match_lo AND r.match_hi GROUP BY r.id
), virtual_counts AS (
    SELECT coalesce(sum(${calendarCountSql('r.rule', 'match_lo', 'match_hi')}-coalesce(e.total,0)),0)::int total,
    coalesce(sum(CASE WHEN has_deadline THEN ${calendarCountSql('r.rule', 'greatest(match_lo,$3::date)', 'least(match_hi,$3::date)')}-coalesce(e.today,0) ELSE 0 END),0)::int today,
    coalesce(sum(CASE WHEN has_deadline THEN ${calendarCountSql('r.rule', 'match_lo', `least(match_hi,${overdueHigh})`)}-coalesce(e.overdue,0) ELSE 0 END),0)::int overdue,
    coalesce(sum(CASE WHEN urgency='URGENT' THEN ${calendarCountSql('r.rule', 'match_lo', 'match_hi')}-coalesce(e.total,0) ELSE 0 END),0)::int urgent,
    coalesce(sum(CASE WHEN has_deadline THEN ${calendarCountSql('r.rule', 'greatest(match_lo,$3::date+1)', 'match_hi')}-coalesce(e.upcoming,0) ELSE 0 END),0)::int upcoming,
    coalesce(sum(CASE WHEN NOT has_deadline THEN ${calendarCountSql('r.rule', 'match_lo', 'match_hi')}-coalesce(e.total,0) ELSE 0 END),0)::int no_deadline
    FROM ranges r LEFT JOIN existing e ON e.id=r.id
)
SELECT (v.total+count(f.identity))::int "totalCount",(v.today+count(f.identity) FILTER (WHERE ${itemConditionsSql.today}))::int today,(v.overdue+count(f.identity) FILTER (WHERE ${itemConditionsSql.overdue}))::int overdue,(v.urgent+count(f.identity) FILTER (WHERE ${itemConditionsSql.urgent}))::int urgent,(v.upcoming+count(f.identity) FILTER (WHERE ${itemConditionsSql.upcoming}))::int upcoming,(v.no_deadline+count(f.identity) FILTER (WHERE ${itemConditionsSql.noDeadline}))::int "noDeadline" FROM virtual_counts v LEFT JOIN filtered_facts f ON true GROUP BY v.total,v.today,v.overdue,v.urgent,v.upcoming,v.no_deadline`;
export const routinePageSql = `${routineSourceSql}, raw_seeds AS (
    SELECT id,match_lo seed FROM ranges WHERE match_lo<=match_hi
    UNION SELECT id,greatest(match_lo,$3::date) FROM ranges WHERE match_lo<=match_hi
    UNION SELECT id,greatest(match_lo,$3::date+1) FROM ranges WHERE match_lo<=match_hi
    UNION SELECT r.id,o.scheduled_date+1 FROM ranges r JOIN routine_task_occurrences o ON o.recurrence_id=r.id AND o.scheduled_date BETWEEN r.match_lo AND r.match_hi WHERE o.scheduled_date<r.match_hi
    UNION SELECT id,greatest(match_lo,$12::date) FROM ranges WHERE $12::date IS NOT NULL AND (has_deadline OR id=$13::uuid)
), seed_values AS (
    SELECT DISTINCT r.id,d.date,'PENDING'::text status,r.urgency,CASE WHEN r.has_deadline THEN d.date ELSE NULL END deadline_date,r.deadline_time,r.id::text || '/' || d.date::text identity
    FROM raw_seeds s JOIN ranges r ON r.id=s.id CROSS JOIN LATERAL (SELECT ${calendarNthSql('r.rule', 's.seed', '0')} date) d WHERE d.date BETWEEN r.match_lo AND r.match_hi AND NOT EXISTS(SELECT 1 FROM routine_task_occurrences o WHERE o.recurrence_id=r.id AND o.scheduled_date=d.date)
), seed_keys AS (SELECT *,${itemSortSql} sort_key FROM seed_values), seeds AS (
    SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY id ORDER BY sort_key) ordinal FROM seed_keys WHERE $10::text IS NULL OR sort_key>$10 OR date=$12::date) ranked WHERE ordinal<=$11+1
), candidate_dates AS MATERIALIZED (
    SELECT DISTINCT r.id,d.date FROM seeds s JOIN ranges r ON r.id=s.id CROSS JOIN LATERAL generate_series(0,$11::int-1) n CROSS JOIN LATERAL (SELECT ${calendarNthSql('r.rule', 's.date', 'n')} date) d
    WHERE d.date BETWEEN r.match_lo AND r.match_hi AND NOT EXISTS (SELECT 1 FROM routine_task_occurrences o WHERE o.recurrence_id=r.id AND o.scheduled_date=d.date)
), virtual AS (
    SELECT (r.snapshot || jsonb_build_object('id',r.id::text || '/' || d.date::text,'recurrenceId',r.id,'scheduledDate',d.date,'kind','OCCURRENCE','materialized',false,'recurrenceVersion',r.version,'version',NULL,'status','PENDING','completion',NULL,'deadline',CASE WHEN r.has_deadline THEN jsonb_build_object('date',d.date,'time',r.deadline_time) ELSE NULL END)) - 'rule' - 'startsOn' - 'endsOn' - 'cancelledAt' - 'cancelledOn' item,r.id::text || '/' || d.date::text identity,'PENDING'::text status,r.urgency,CASE WHEN r.has_deadline THEN d.date ELSE NULL END deadline_date,r.deadline_time,d.date::text scheduled_date
    FROM candidate_dates d JOIN ranges r ON r.id=d.id
), combined AS (SELECT * FROM filtered_facts UNION ALL SELECT * FROM virtual), ordered AS (SELECT item,${itemSortSql} AS sort_key FROM combined)
SELECT item AS task,sort_key AS "sortKey" FROM ordered WHERE $10::text IS NULL OR sort_key>$10 ORDER BY sort_key LIMIT $11`;
