import { Toaster } from "@/components/ui/sonner"
import { FinanceApp } from "@/finance"

export default function App() {
  return (
    <>
      <FinanceApp />
      <Toaster position="top-center" />
    </>
  )
}
