"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Plus, AlertCircle } from "lucide-react"
import { useForm, useWatch } from "react-hook-form"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Form } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const GUEST_OPTION_VALUE = "__guest__"
const TOTAL_POINTS = 100000

// DBのSeedデータと完全に一致させたUUIDモック
const memberOptions = [
  { id: "11111111-1111-1111-1111-111111111111", name: "こうすけ" },
  { id: "22222222-2222-2222-2222-222222222222", name: "さとし" },
  { id: "33333333-3333-3333-3333-333333333333", name: "りな" },
  { id: "44444444-4444-4444-4444-444444444444", name: "ゆうた" },
  { id: "55555555-5555-5555-5555-555555555555", name: "あや" },
]

const playerSchema = z
  .object({
    player_id: z.string().min(1, "メンバーを選択してください"),
    is_guest: z.boolean(),
    guest_name: z.string(),
    raw_score: z
      .number()
      .int("持ち点は整数で入力してください")
      .max(TOTAL_POINTS, `持ち点は${TOTAL_POINTS.toLocaleString()}以下で入力してください`)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.raw_score === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["raw_score"], message: "持ち点を入力してください" })
    }
    if (value.is_guest) {
      if (value.player_id !== GUEST_OPTION_VALUE) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["player_id"], message: "ゲスト入力を選択してください" })
      }
      if (value.guest_name.trim().length < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["guest_name"], message: "ゲスト名を入力してください" })
      }
    }
    if (!value.is_guest && value.player_id === GUEST_OPTION_VALUE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["player_id"], message: "メンバーを選択してください" })
    }
  })

const matchFormSchema = z
  .object({
    players: z.array(playerSchema).length(4, "4人分の入力が必要です"),
  })
  .superRefine((value, ctx) => {
    const selectedMemberIds = value.players.filter((player) => !player.is_guest).map((player) => player.player_id)
    const duplicateMembers = selectedMemberIds.filter((memberId, index, arr) => arr.indexOf(memberId) !== index)

    if (duplicateMembers.length > 0) {
      value.players.forEach((player, index) => {
        if (!player.is_guest && duplicateMembers.includes(player.player_id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["players", index, "player_id"], message: "同じメンバーは選択できません" })
        }
      })
    }
  })

type MatchFormValues = z.infer<typeof matchFormSchema>

type CalculateResponse = {
  player_id: string
  raw_score: number
  point: number
  rank: number
}

type PreviewRow = {
  player_id: string
  name: string
  raw_score: number
  point: number
  rank: number
  is_guest: boolean
}

export function MatchInputForm() {
  const router = useRouter()
  const [previewRows, setPreviewRows] = React.useState<PreviewRow[]>([])
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false)
  const [isCalculating, setIsCalculating] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [apiError, setApiError] = React.useState<string | null>(null)

  const form = useForm<MatchFormValues>({
    resolver: zodResolver(matchFormSchema),
    mode: "onSubmit",
    defaultValues: {
      players: Array.from({ length: 4 }, () => ({
        player_id: "",
        is_guest: false,
        guest_name: "",
        raw_score: undefined,
      })),
    },
  })

  const players = useWatch({ control: form.control, name: "players" })

  // 自動計算はUXが悪いので廃止し、現在の合計点をリアルタイム算出
  const totalScore = players.reduce((sum, player) => {
    const score = Number(player.raw_score)
    return sum + (Number.isFinite(score) ? score : 0)
  }, 0)
  const remainingScore = TOTAL_POINTS - totalScore

  const buildPlayersForApi = React.useCallback((values: MatchFormValues) => {
    return values.players.map((player) => {
      if (player.is_guest) {
        return {
          player_id: crypto.randomUUID(), // API側でエラーにならないよう一時UUID
          raw_score: player.raw_score,
          name: player.guest_name.trim(),
          is_guest: true
        }
      }
      const member = memberOptions.find((item) => item.id === player.player_id)
      return {
        player_id: player.player_id,
        raw_score: player.raw_score,
        name: member?.name ?? "メンバー",
        is_guest: false
      }
    })
  }, [])

  const calculatePreviewRows = React.useCallback(
    async (values: MatchFormValues) => {
      // 合計点が10万点ピッタリでない場合はプレビューさせない
      if (totalScore !== TOTAL_POINTS) {
        throw new Error(`合計点が ${TOTAL_POINTS.toLocaleString()}点 になっていません（現在: ${totalScore.toLocaleString()}点）`)
      }

      const baseUrl = process.env.NEXT_PUBLIC_API_URL
      if (!baseUrl) {
        throw new Error("NEXT_PUBLIC_API_URL が設定されていません")
      }

      const resolvedPlayers = buildPlayersForApi(values)

      const calculateResponse = await fetch(`${baseUrl}/api/matches/calculate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          players: resolvedPlayers.map((player) => ({
            player_id: player.player_id,
            raw_score: player.raw_score,
          })),
        }),
      })

      if (!calculateResponse.ok) {
        const errorBody = await calculateResponse.text()
        throw new Error(errorBody || "計算APIの呼び出しに失敗しました")
      }

      const calculatedRows = (await calculateResponse.json()) as CalculateResponse[]
      const resolvedMap = new Map(resolvedPlayers.map((player) => [player.player_id, player]))

      return calculatedRows
        .map((row) => {
          const p = resolvedMap.get(row.player_id)
          return {
            player_id: row.player_id,
            name: p?.name ?? "プレイヤー",
            raw_score: row.raw_score,
            point: row.point,
            rank: row.rank,
            is_guest: p?.is_guest ?? false,
          }
        })
        .sort((a, b) => a.rank - b.rank)
    },
    [buildPlayersForApi, totalScore]
  )

  const handlePreview = React.useCallback(
    async (values: MatchFormValues) => {
      setApiError(null)
      setIsCalculating(true)

      try {
        const sortedRows = await calculatePreviewRows(values)
        setPreviewRows(sortedRows)
        setIsPreviewOpen(true)
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "プレビュー取得に失敗しました")
      } finally {
        setIsCalculating(false)
      }
    },
    [calculatePreviewRows]
  )

  const handleSaveRows = React.useCallback(
    async (rows: PreviewRow[]) => {
      if (rows.length !== 4) {
        setApiError("プレビュー結果が不正です。再度プレビューしてください")
        return false
      }

      // ゲストを含む場合はDBの外部キー制約で落ちるため保存をブロック
      if (rows.some((row) => row.is_guest)) {
        setApiError("【エラー】現在ゲストを含めた成績の保存には対応していません。登録済みメンバーのみで保存してください。")
        return false
      }

      setIsSaving(true)
      setApiError(null)

      try {
        const baseUrl = process.env.NEXT_PUBLIC_API_URL
        const ruleId = process.env.NEXT_PUBLIC_RULE_ID

        if (!baseUrl) throw new Error("NEXT_PUBLIC_API_URL が設定されていません")
        if (!ruleId) throw new Error("NEXT_PUBLIC_RULE_ID が設定されていません")

        const saveResponse = await fetch(`${baseUrl}/api/matches`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            rule_id: ruleId,
            season_id: null,
            results: rows.map((row) => ({
              player_id: row.player_id,
              raw_score: row.raw_score,
              point: row.point,
              rank: row.rank,
              is_yakuman: false,
            })),
          }),
        })

        if (!saveResponse.ok) {
          const errorBody = await saveResponse.text()
          throw new Error(errorBody || "保存APIの呼び出しに失敗しました")
        }

        setIsPreviewOpen(false)
        router.push("/matches")
        router.refresh()
        return true
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "保存に失敗しました")
        return false
      } finally {
        setIsSaving(false)
      }
    },
    [router]
  )

  const handleSave = React.useCallback(async () => {
    if (previewRows.length !== 4) {
      setApiError("プレビュー結果が不正です。再度プレビューしてください")
      return
    }
    await handleSaveRows(previewRows)
  }, [handleSaveRows, previewRows])

  const handleSaveDirect = React.useCallback(
    async (values: MatchFormValues) => {
      setApiError(null)
      setIsCalculating(true)

      try {
        const rows = await calculatePreviewRows(values)
        setPreviewRows(rows)
        await handleSaveRows(rows)
      } catch (error) {
        setApiError(error instanceof Error ? error.message : "保存に失敗しました")
      } finally {
        setIsCalculating(false)
      }
    },
    [calculatePreviewRows, handleSaveRows]
  )

  return (
    <>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handlePreview)} className="space-y-4 pb-20">
          {players.map((player, index) => {
            const isGuest = Boolean(player?.is_guest)
            const playerCardTitle = index === 0 ? `プレイヤー ${index + 1}（起家）` : `プレイヤー ${index + 1}`

            return (
              <Card key={`player-input-${index}`}>
                <CardHeader>
                  <CardTitle className="text-base">{playerCardTitle}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor={`player-${index}`}>メンバー選択</Label>
                    <Select
                      value={player?.player_id ?? ""}
                      onValueChange={(value) => {
                        const guestSelected = value === GUEST_OPTION_VALUE

                        form.setValue(`players.${index}.player_id`, value, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                        form.setValue(`players.${index}.is_guest`, guestSelected, {
                          shouldDirty: true,
                        })

                        if (!guestSelected) {
                          form.setValue(`players.${index}.guest_name`, "", {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }
                      }}
                    >
                      <SelectTrigger className="h-12 text-base">
                        <SelectValue placeholder="メンバーを選択" />
                        <SelectContent>
                          {memberOptions.map((member) => (
                            <SelectItem key={member.id} value={member.id}>
                              {member.name}
                            </SelectItem>
                          ))}
                          <SelectItem value={GUEST_OPTION_VALUE}>＋ ゲスト入力</SelectItem>
                        </SelectContent>
                      </SelectTrigger>
                    </Select>
                    {form.formState.errors.players?.[index]?.player_id ? (
                      <p className="text-sm text-destructive">{form.formState.errors.players[index]?.player_id?.message}</p>
                    ) : null}
                  </div>

                  {isGuest ? (
                    <div className="space-y-2">
                      <Label htmlFor={`guest-name-${index}`}>ゲスト名</Label>
                      <Input
                        id={`guest-name-${index}`}
                        type="text"
                        placeholder="ゲスト名を入力"
                        className="h-12 text-base"
                        {...form.register(`players.${index}.guest_name`)}
                      />
                      {form.formState.errors.players?.[index]?.guest_name ? (
                        <p className="text-sm text-destructive">{form.formState.errors.players[index]?.guest_name?.message}</p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <Label htmlFor={`raw-score-${index}`}>持ち点</Label>
                    <div className="relative flex items-center">
                      <Input
                        id={`raw-score-${index}`}
                        type="number"
                        inputMode="numeric"
                        className="h-12 pr-10 text-right font-mono text-base"
                        placeholder="例: 250"
                        value={
                          player?.raw_score === undefined || player?.raw_score === null
                            ? ""
                            : String(Math.trunc(Number(player.raw_score) / 100))
                        }
                        onChange={(event) => {
                          const rawValue = event.target.value
                          if (rawValue === "") {
                            form.setValue(`players.${index}.raw_score`, undefined, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                            return
                          }

                          const shortScore = Number(rawValue)
                          if (!Number.isFinite(shortScore)) {
                            return
                          }

                          form.setValue(`players.${index}.raw_score`, Math.trunc(shortScore) * 100, {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }}
                      />
                      <span className="pointer-events-none absolute right-3 text-sm text-muted-foreground">00</span>
                    </div>
                    {form.formState.errors.players?.[index]?.raw_score ? (
                      <p className="text-sm text-destructive">{form.formState.errors.players[index]?.raw_score?.message}</p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            )
          })}

          {/* 点数サマリー表示 (UX改善) */}
          <Card className="border-muted bg-muted/20">
            <CardContent className="flex flex-col items-center justify-center p-4 gap-1">
              <div className="text-sm font-medium text-muted-foreground">現在の合計点</div>
              <div className={`text-2xl font-bold ${remainingScore === 0 ? "text-emerald-600" : "text-destructive"}`}>
                {totalScore.toLocaleString()} 点
              </div>
              <div className={`text-sm font-medium ${remainingScore === 0 ? "text-emerald-600" : "text-destructive"}`}>
                {remainingScore === 0 
                  ? "✓ 100,000点ぴったりです" 
                  : remainingScore > 0 
                    ? `残り ${remainingScore.toLocaleString()} 点足りません` 
                    : `100,000点を ${Math.abs(remainingScore).toLocaleString()} 点オーバーしています`}
              </div>
            </CardContent>
          </Card>

          {apiError ? (
            <div className="flex items-center gap-2 text-destructive bg-destructive/10 p-3 rounded-md">
              <AlertCircle className="size-4 shrink-0" />
              <p className="text-sm font-medium">{apiError}</p>
            </div>
          ) : null}

          <Button type="submit" variant="outline" size="lg" className="h-12 w-full text-base font-bold shadow-sm" disabled={isCalculating || isSaving}>
            {isCalculating ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                計算中...
              </>
            ) : (
              <>
                <Plus className="mr-2 size-4" />
                計算結果をプレビュー
              </>
            )}
          </Button>

          <Button
            type="button"
            size="lg"
            className="h-12 w-full text-base font-bold shadow-sm"
            disabled={isCalculating || isSaving}
            onClick={() => void form.handleSubmit(handleSaveDirect)()}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                保存中...
              </>
            ) : (
              "この内容で保存"
            )}
          </Button>
        </form>
      </Form>

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="max-w-[400px] rounded-lg">
          <DialogHeader>
            <DialogTitle>計算結果プレビュー</DialogTitle>
            <DialogDescription>順位と最終ポイントを確認して保存してください。</DialogDescription>
          </DialogHeader>

          <div className="space-y-2 my-2">
            {previewRows.map((row) => (
              <Card key={`preview-${row.player_id}`} className="border-muted">
                <CardContent className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center justify-center size-6 rounded-full text-xs font-bold ${row.rank === 1 ? 'bg-rose-100 text-rose-600' : 'bg-muted text-muted-foreground'}`}>
                      {row.rank}
                    </div>
                    <div>
                      <p className="text-sm font-medium flex items-center gap-1">
                        {row.name}
                        {row.is_guest && <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">ゲスト</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{row.raw_score.toLocaleString()}点</p>
                    </div>
                  </div>
                  <p className={`text-lg font-bold ${row.point >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {row.point >= 0 ? "+" : ""}
                    {row.point.toFixed(1)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" className="h-11 text-base w-full sm:w-auto" disabled={isSaving} onClick={() => setIsPreviewOpen(false)}>
              戻る
            </Button>
            <Button type="button" className="h-11 text-base w-full sm:w-auto" disabled={isSaving} onClick={() => void handleSave()}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  保存中...
                </>
              ) : (
                "この内容で保存"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
