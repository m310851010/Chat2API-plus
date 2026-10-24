/**
 * Model Editor Component
 * Manages default and custom models for a provider
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { useProvidersStore } from '@/stores/providersStore'
import type { EffectiveModel } from '@/types/electron'
import { Plus, Pencil, Trash2, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react'

interface ModelEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerName: string
}

export function ModelEditor({
  open,
  onOpenChange,
  providerId,
  providerName,
}: ModelEditorProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const setModelsLastUpdated = useProvidersStore((state) => state.setModelsLastUpdated)

  const [models, setModels] = useState<EffectiveModel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newActualModelId, setNewActualModelId] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null)
  const [isResetting, setIsResetting] = useState(false)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      loadModels()
    }
  }, [open, providerId])

  const loadModels = async () => {
    setIsLoading(true)
    try {
      const effectiveModels = await window.electronAPI.providers.getEffectiveModels(providerId)
      setModels(effectiveModels || [])
    } catch (error) {
      console.error('Failed to load models:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Failed to load models',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const defaultModels = models.filter(m => !m.isCustom)
  const customModels = models.filter(m => m.isCustom)

  const handleAddModel = async () => {
    if (!newDisplayName.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameRequired'),
        variant: 'destructive',
      })
      return
    }

    if (!newActualModelId.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.idRequired'),
        variant: 'destructive',
      })
      return
    }

    if (models.some(m => m.displayName === newDisplayName.trim())) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameExists'),
        variant: 'destructive',
      })
      return
    }

    setIsAdding(true)
    try {
      const result = await window.electronAPI.providers.addCustomModel(providerId, {
        displayName: newDisplayName.trim(),
        actualModelId: newActualModelId.trim(),
      })

      if (result.success) {
        setModels(result.models)
        setNewDisplayName('')
        setNewActualModelId('')
        setIsAddDialogOpen(false)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.addSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to add model')
      }
    } catch (error) {
      console.error('Failed to add model:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.addError'),
        variant: 'destructive',
      })
    } finally {
      setIsAdding(false)
    }
  }

  const handleEditModel = async () => {
    if (!editingOriginalName) return

    if (!newDisplayName.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameRequired'),
        variant: 'destructive',
      })
      return
    }

    if (!newActualModelId.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.idRequired'),
        variant: 'destructive',
      })
      return
    }

    if (models.some(m => m.displayName === newDisplayName.trim() && m.displayName !== editingOriginalName)) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameExists'),
        variant: 'destructive',
      })
      return
    }

    setIsEditing(true)
    try {
      const result = await window.electronAPI.providers.updateModel(providerId, editingOriginalName, {
        displayName: newDisplayName.trim(),
        actualModelId: newActualModelId.trim(),
      })

      if (result.success) {
        setModels(result.models)
        closeEditDialog()
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.editSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to update model')
      }
    } catch (error) {
      console.error('Failed to update model:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.editError'),
        variant: 'destructive',
      })
    } finally {
      setIsEditing(false)
    }
  }

  const openEditDialog = (model: EffectiveModel) => {
    setEditingOriginalName(model.displayName)
    setNewDisplayName(model.displayName)
    setNewActualModelId(model.actualModelId)
    setIsEditDialogOpen(true)
  }

  const closeEditDialog = () => {
    setIsEditDialogOpen(false)
    setEditingOriginalName(null)
    setNewDisplayName('')
    setNewActualModelId('')
  }

  const handleRemoveModel = async (modelName: string) => {
    setDeletingModel(modelName)
    try {
      const result = await window.electronAPI.providers.removeModel(providerId, modelName)

      if (result.success) {
        setModels(result.models)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.removeSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to remove model')
      }
    } catch (error) {
      console.error('Failed to remove model:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.removeError'),
        variant: 'destructive',
      })
    } finally {
      setDeletingModel(null)
    }
  }

  const handleResetModels = async () => {
    if (!window.confirm(t('modelEditor.confirmReset'))) {
      return
    }

    setIsResetting(true)
    try {
      const result = await window.electronAPI.providers.resetModels(providerId)

      if (result.success) {
        setModels(result.models)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.resetSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to reset models')
      }
    } catch (error) {
      console.error('Failed to reset models:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.resetError'),
        variant: 'destructive',
      })
    } finally {
      setIsResetting(false)
    }
  }

  const renderModelTable = (modelList: EffectiveModel[]) => {
    if (modelList.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground border rounded-lg">
          <p className="text-sm">{t('modelEditor.noModels')}</p>
        </div>
      )
    }

    return (
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('modelEditor.displayName')}</TableHead>
              <TableHead>{t('modelEditor.actualModelId')}</TableHead>
              <TableHead className="w-[80px]">{t('modelEditor.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modelList.map((model) => {
              const isDeleting = deletingModel === model.displayName
              const showBoth = model.displayName !== model.actualModelId

              return (
                <TableRow key={model.displayName}>
                  <TableCell>
                    <code className="text-sm">{model.displayName}</code>
                  </TableCell>
                  <TableCell>
                    <code className="text-sm">
                      {showBoth ? model.actualModelId : model.displayName}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(model)}
                        disabled={isDeleting}
                        className="h-8 w-8"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (window.confirm(t('modelEditor.confirmDelete'))) {
                            handleRemoveModel(model.displayName)
                          }
                        }}
                        disabled={isDeleting}
                        className="h-8 w-8 text-destructive hover:text-destructive"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('modelEditor.title', { name: providerName })}
            </DialogTitle>
            <DialogDescription>
              {t('modelEditor.warningMessage')}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6 mt-4">
              <div>
                <h3 className="text-lg font-semibold mb-3">{t('modelEditor.defaultModels')}</h3>
                {renderModelTable(defaultModels)}
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-3">{t('modelEditor.customModels')}</h3>
                {renderModelTable(customModels)}
              </div>

              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t('modelEditor.warningMessage')}
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter className="mt-6">
            <div className="flex gap-2 w-full justify-between">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsAddDialogOpen(true)}
                  disabled={isLoading}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {t('modelEditor.addModel')}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleResetModels}
                  disabled={isLoading || isResetting}
                >
                  {isResetting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4 mr-2" />
                  )}
                  {t('modelEditor.resetDefault')}
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('modelEditor.cancel')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('modelEditor.addDialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('modelEditor.displayNameLabel')}</Label>
              <Input
                id="displayName"
                placeholder={t('modelEditor.displayNamePlaceholder')}
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.displayNameHelp')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="actualModelId">{t('modelEditor.actualIdLabel')}</Label>
              <Input
                id="actualModelId"
                placeholder={t('modelEditor.actualIdPlaceholder')}
                value={newActualModelId}
                onChange={(e) => setNewActualModelId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.actualIdHelp')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddDialogOpen(false)
                setNewDisplayName('')
                setNewActualModelId('')
              }}
              disabled={isAdding}
            >
              {t('modelEditor.cancel')}
            </Button>
            <Button onClick={handleAddModel} disabled={isAdding}>
              {isAdding ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                t('modelEditor.add')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditDialogOpen} onOpenChange={(open) => {
        if (!open) closeEditDialog()
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('modelEditor.editDialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="editDisplayName">{t('modelEditor.displayNameLabel')}</Label>
              <Input
                id="editDisplayName"
                placeholder={t('modelEditor.displayNamePlaceholder')}
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.displayNameHelp')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="editActualModelId">{t('modelEditor.actualIdLabel')}</Label>
              <Input
                id="editActualModelId"
                placeholder={t('modelEditor.actualIdPlaceholder')}
                value={newActualModelId}
                onChange={(e) => setNewActualModelId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.actualIdHelp')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeEditDialog}
              disabled={isEditing}
            >
              {t('modelEditor.cancel')}
            </Button>
            <Button onClick={handleEditModel} disabled={isEditing}>
              {isEditing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                t('modelEditor.save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default ModelEditor
