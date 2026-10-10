import { Coffee, House, Mountain, Plane, ShoppingBag, Utensils, Wallet, Heart, Sparkles, Car, type LucideIcon } from 'lucide-react'
import type { Member } from '../types'

export const GROUP_ICONS: { id: string; label: string; Icon: LucideIcon; color: string }[] = [
  { id: 'mountain', label: 'Adventure', Icon: Mountain, color: '#e8e5f4' },
  { id: 'food', label: 'Food', Icon: Utensils, color: '#faead6' },
  { id: 'home', label: 'Home', Icon: House, color: '#e2ece5' },
  { id: 'plane', label: 'Travel', Icon: Plane, color: '#e1ebf3' },
  { id: 'heart', label: 'Together', Icon: Heart, color: '#f6e2e6' },
  { id: 'sparkles', label: 'Other', Icon: Sparkles, color: '#eee7dc' },
]
export const CATEGORIES: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: 'food', label: 'Food & drinks', Icon: Utensils },
  { id: 'stay', label: 'Accommodation', Icon: House },
  { id: 'transport', label: 'Transport', Icon: Car },
  { id: 'shopping', label: 'Shopping', Icon: ShoppingBag },
  { id: 'coffee', label: 'Coffee', Icon: Coffee },
  { id: 'other', label: 'Other', Icon: Wallet },
]
export function GroupIcon({ id, color, large = false }: { id: string; color: string; large?: boolean }) {
  const Icon = GROUP_ICONS.find(icon => icon.id === id)?.Icon ?? Sparkles
  return <div className={`group-icon ${large ? 'large' : ''}`} style={{ background: color }}><Icon size={large ? 32 : 25} strokeWidth={1.7}/></div>
}
export function Avatar({ member, index = 0, small = false }: { member: Member; index?: number; small?: boolean }) {
  return <span className={`avatar avatar-${index % 6} ${small ? 'small' : ''}`} aria-label={member.name} title={member.name}>{member.name.trim().split(/\s+/).map(n => n[0]).slice(0, 2).join('').toUpperCase()}</span>
}
export function ReceiptArt() {
  return <svg className="receipt-art" viewBox="0 0 350 210" aria-hidden="true">
    <ellipse cx="185" cy="181" rx="128" ry="15" fill="#0b6b57" opacity=".07"/>
    <path d="M141 24l130 11-12 150-10-8-10 6-10-8-10 6-10-8-10 6-10-8-10 6-10-8-10 6-10-8-10 6-10-8z" fill="#fffdf7" stroke="#d4ded2" strokeWidth="1.5" transform="rotate(10 206 100)"/>
    <path d="M168 52h71m-72 17h52m-55 20h70m-72 17h45m-48 28h68" stroke="#c5d6ca" strokeWidth="5" strokeLinecap="round" transform="rotate(10 206 100)"/>
    <circle cx="101" cy="127" r="46" fill="#d6bde9" stroke="#f7f6f2" strokeWidth="5"/>
    <path d="M85 129l12 12 22-26" fill="none" stroke="#624878" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="269" cy="67" r="32" fill="#ecc273" stroke="#f7f6f2" strokeWidth="5"/>
    <path d="M264 52v30m10-25h-12a6 6 0 000 12h7a6 6 0 010 12h-13" stroke="#927337" strokeWidth="3" fill="none" strokeLinecap="round"/>
    <path d="M63 66l5-13 5 13 13 5-13 5-5 13-5-13-13-5zm218 82l3-8 3 8 8 3-8 3-3 8-3-8-8-3z" fill="#0b6b57" opacity=".7"/>
  </svg>
}
