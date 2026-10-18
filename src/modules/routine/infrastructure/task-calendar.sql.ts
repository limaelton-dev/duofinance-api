const monthDate = (rule: string, date: string) =>
    `(date_trunc('month',(${date})::timestamp)::date + (least((${rule}->>'day')::int,extract(day FROM (date_trunc('month',(${date})::timestamp)+interval '1 month - 1 day'))::int)-1))`;
const yearDate = (rule: string, date: string) =>
    `(make_date(extract(year FROM (${date})::date)::int,(${rule}->>'month')::int,1)+(least((${rule}->>'day')::int,extract(day FROM (make_date(extract(year FROM (${date})::date)::int,(${rule}->>'month')::int,1)+interval '1 month - 1 day'))::int)-1))`;
export function calendarCountSql(rule: string, lower: string, upper: string) {
    const weekly = (weekday: string) =>
        `CASE WHEN hi < lo+((${weekday}-extract(isodow FROM lo)::int+7)%7) THEN 0 ELSE (hi-(lo+((${weekday}-extract(isodow FROM lo)::int+7)%7)))/7+1 END`;
    return `(SELECT CASE WHEN lo>hi THEN 0 ELSE CASE rule->>'frequency'
        WHEN 'DAILY' THEN hi-lo+1
        WHEN 'WEEKLY' THEN ${weekly("(rule->>'weekday')::int")}
        WHEN 'WEEKDAYS' THEN (SELECT coalesce(sum(${weekly('weekday::int')}),0)::int FROM jsonb_array_elements_text(rule->'weekdays') weekday)
        WHEN 'MONTHLY' THEN (extract(year FROM hi)::int-extract(year FROM lo)::int)*12+extract(month FROM hi)::int-extract(month FROM lo)::int+1-(${monthDate('rule', 'lo')}<lo)::int-(${monthDate('rule', 'hi')}>hi)::int
        WHEN 'ANNUAL' THEN extract(year FROM hi)::int-extract(year FROM lo)::int+1-(${yearDate('rule', 'lo')}<lo)::int-(${yearDate('rule', 'hi')}>hi)::int END END::int
        FROM (SELECT (${rule})::jsonb rule,(${lower})::date lo,(${upper})::date hi) calendar)`;
}
export function calendarNthSql(rule: string, seed: string, index: string) {
    const firstMonth = `(date_trunc('month',seed::timestamp)::date+CASE WHEN ${monthDate('rule', 'seed')}<seed THEN interval '1 month' ELSE interval '0 month' END+n*interval '1 month')`;
    const firstYear = `(seed+CASE WHEN ${yearDate('rule', 'seed')}<seed THEN interval '1 year' ELSE interval '0 year' END+n*interval '1 year')`;
    return `(SELECT CASE rule->>'frequency'
        WHEN 'DAILY' THEN seed+n
        WHEN 'WEEKLY' THEN seed+(((rule->>'weekday')::int-extract(isodow FROM seed)::int+7)%7)+7*n
        WHEN 'WEEKDAYS' THEN (SELECT seed+7*(n/cardinality(offsets))+offsets[(n%cardinality(offsets))+1] FROM (SELECT ARRAY(SELECT ((weekday::int-extract(isodow FROM seed)::int+7)%7) FROM jsonb_array_elements_text(rule->'weekdays') weekday ORDER BY 1) offsets) days)
        WHEN 'MONTHLY' THEN ${monthDate('rule', firstMonth)}
        WHEN 'ANNUAL' THEN ${yearDate('rule', firstYear)} END::date
        FROM (SELECT (${rule})::jsonb rule,(${seed})::date seed,(${index})::int n) calendar)`;
}
