import type { FieldDef } from '@/components/crud/ResourceForm'

export const PROJECT_STATUSES = [
  { value: 'planning', label: 'Planning' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

export const TZ_REGIONS = [
  'Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma', 'Kilimanjaro', 'Lindi', 'Manyara', 'Mara',
  'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza', 'Njombe', 'Pemba North', 'Pemba South', 'Pwani', 'Rukwa', 'Ruvuma', 'Shinyanga', 'Simiyu',
  'Singida', 'Songwe', 'Tabora', 'Tanga', 'Unguja North', 'Unguja South', 'Unguja Urban West',
].map((r) => ({ value: r, label: r }))

export const projectFields: FieldDef[] = [
  { name: 'name', label: 'Project name', type: 'text', required: true, span: 2, maxLength: 200 },
  { name: 'code', label: 'Project code', type: 'text', hint: 'Leave blank to auto-number', disabled: (_v, editing) => editing },
  {
    name: 'client_id',
    label: 'Client',
    type: 'relation',
    relation: { table: 'clients', select: 'id,name', label: (c) => c.name, order: 'name' },
  },
  { name: 'location', label: 'Site location', type: 'text', placeholder: 'e.g. Plot 12, Mikocheni' },
  { name: 'region', label: 'Region', type: 'select', options: TZ_REGIONS },
  { name: 'start_date', label: 'Start date', type: 'date' },
  { name: 'end_date', label: 'Completion date', type: 'date' },
  { name: 'contract_value', label: 'Contract value', type: 'money', required: true, defaultValue: 0 },
  { name: 'budget', label: 'Budget (cost)', type: 'money', required: true, defaultValue: 0 },
  { name: 'currency', label: 'Currency', type: 'currency', defaultValue: 'TZS' },
  { name: 'status', label: 'Status', type: 'select', options: PROJECT_STATUSES, required: true, defaultValue: 'planning' },
  {
    name: 'project_manager_id',
    label: 'Project manager',
    type: 'relation',
    relation: {
      table: 'profiles',
      select: 'id,full_name,is_active,role:roles(key,name)',
      label: (p) => `${p.full_name} (${p.role?.name ?? ''})`,
      order: 'full_name',
      filter: (p) => p.is_active,
    },
  },
  { name: 'progress', label: 'Progress %', type: 'percent', defaultValue: 0, hint: 'Also updated automatically by approved site reports' },
  { name: 'description', label: 'Scope / description', type: 'textarea' },
]

export const clientFields: FieldDef[] = [
  { name: 'name', label: 'Client name', type: 'text', required: true, span: 2 },
  {
    name: 'client_type',
    label: 'Type',
    type: 'select',
    required: true,
    defaultValue: 'company',
    options: [
      { value: 'company', label: 'Company' },
      { value: 'government', label: 'Government / Parastatal' },
      { value: 'individual', label: 'Individual' },
      { value: 'ngo', label: 'NGO' },
    ],
  },
  { name: 'contact_person', label: 'Contact person', type: 'text' },
  { name: 'phone', label: 'Phone', type: 'tel' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'tin', label: 'TIN', type: 'text' },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]
