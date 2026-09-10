import { redirect } from 'next/navigation';

// Saved links enter the provider workflow; approved requests provision agents.
export default function OnboardPage() {
  redirect('/resources');
}
