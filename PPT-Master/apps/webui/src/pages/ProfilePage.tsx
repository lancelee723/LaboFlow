import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ProfilePage() {
  const { t } = useTranslation("common")
  const { user } = useAuth()
  const navigate = useNavigate()
  const isMustChange = new URLSearchParams(window.location.search).get("must_change") === "1"

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")

    if (newPassword !== confirmPassword) {
      setError(t("profile.mismatch"))
      return
    }

    if (newPassword.length < 6) {
      setError(t("profile.too_short"))
      return
    }

    setIsSaving(true)
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || t("profile.failed"))
      }
      setSuccess(t("profile.success"))
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")

      if (isMustChange) {
        setTimeout(() => navigate("/"), 1500)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.failed"))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-xl">
      <h1 className="text-2xl font-bold mb-6">{t("profile.title")}</h1>

      {isMustChange && (
        <Card className="mb-6 border-destructive/50 bg-destructive/5">
          <CardContent className="p-4">
            <p className="text-sm font-medium text-destructive">
              {t("profile.must_change_banner")}
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("profile.account_title")}</CardTitle>
          <CardDescription>{t("profile.account_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("profile.email_label")}</span>
            <span className="font-medium">{user?.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("profile.role_label")}</span>
            <span className="font-medium capitalize">{user?.role}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("profile.change_password_title")}</CardTitle>
          <CardDescription>{t("profile.change_password_desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            {success && (
              <div className="rounded-md bg-green-100 p-3 text-sm text-green-700">{success}</div>
            )}

            <div className="space-y-2">
              <Label htmlFor="current">
                {isMustChange ? t("profile.initial_password") : t("profile.current_password")}
              </Label>
              <Input
                id="current"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={isMustChange ? t("profile.initial_password_placeholder") : ""}
                required
              />
              {isMustChange && (
                <p className="text-xs text-muted-foreground">
                  {t("profile.initial_password_hint")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="new">{t("profile.new_password")}</Label>
              <Input
                id="new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm">{t("profile.confirm_password")}</Label>
              <Input
                id="confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" disabled={isSaving}>
              {isSaving ? t("profile.saving") : t("profile.change_button")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
