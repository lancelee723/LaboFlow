import { useMemo } from 'react'
import { useGraphStore, RawNodeType, RawEdgeType } from '@/stores/graph'
import Text from '@/components/ui/Text'
import Button from '@/components/ui/Button'
import useLightragGraph from '@/hooks/useLightragGraph'
import { useTranslation } from 'react-i18next'
import { GitBranchPlus, Scissors } from 'lucide-react'
import EditablePropertyRow from './EditablePropertyRow'

/**
 * Component that view properties of elements in graph.
 */
const PropertiesView = () => {
  const { getNode, getEdge } = useLightragGraph()
  const selectedNode = useGraphStore.use.selectedNode()
  const focusedNode = useGraphStore.use.focusedNode()
  const selectedEdge = useGraphStore.use.selectedEdge()
  const focusedEdge = useGraphStore.use.focusedEdge()
  const graphDataVersion = useGraphStore.use.graphDataVersion()

  const { currentElement, currentType } = useMemo(() => {
    let type: 'node' | 'edge' | null = null
    let element: RawNodeType | RawEdgeType | null = null
    if (focusedNode) {
      type = 'node'
      element = getNode(focusedNode)
    } else if (selectedNode) {
      type = 'node'
      element = getNode(selectedNode)
    } else if (focusedEdge) {
      type = 'edge'
      element = getEdge(focusedEdge, true)
    } else if (selectedEdge) {
      type = 'edge'
      element = getEdge(selectedEdge, true)
    }

    if (element) {
      return {
        currentElement: type === 'node'
          ? refineNodeProperties(element as any)
          : refineEdgeProperties(element as any),
        currentType: type
      }
    }
    return { currentElement: null, currentType: null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedNode, selectedNode, focusedEdge, selectedEdge, graphDataVersion, getNode, getEdge])

  if (!currentElement) {
    return <></>
  }

  const panelClassName =
    'max-w-sm rounded-[24px] border border-black/10 bg-white/92 p-3 text-xs shadow-[0_4px_18px_rgba(0,0,0,0.04),0_2.025px_7.84688px_rgba(0,0,0,0.027),0_0.8px_2.925px_rgba(0,0,0,0.02),0_0.175px_1.04062px_rgba(0,0,0,0.01)] backdrop-blur-xl dark:border-white/10 dark:bg-[#1f1c1a]/92'

  return (
    <div className={panelClassName}>
      {currentType == 'node' ? (
        <NodePropertiesView node={currentElement as any} />
      ) : (
        <EdgePropertiesView edge={currentElement as any} />
      )}
    </div>
  )
}

type NodeType = RawNodeType & {
  relationships: {
    type: string
    id: string
    label: string
  }[]
}

type EdgeType = RawEdgeType & {
  sourceNode?: RawNodeType
  targetNode?: RawNodeType
}

const refineNodeProperties = (node: RawNodeType): NodeType => {
  const state = useGraphStore.getState()
  const relationships = []

  if (state.sigmaGraph && state.rawGraph) {
    try {
      if (!state.sigmaGraph.hasNode(node.id)) {
        console.warn('Node not found in sigmaGraph:', node.id)
        return {
          ...node,
          relationships: []
        }
      }

      const edges = state.sigmaGraph.edges(node.id)

      for (const edgeId of edges) {
        if (!state.sigmaGraph.hasEdge(edgeId)) continue;

        const edge = state.rawGraph.getEdge(edgeId, true)
        if (edge) {
          const isTarget = node.id === edge.source
          const neighbourId = isTarget ? edge.target : edge.source

          if (!state.sigmaGraph.hasNode(neighbourId)) continue;

          const neighbour = state.rawGraph.getNode(neighbourId)
          if (neighbour) {
            relationships.push({
              type: 'Neighbour',
              id: neighbourId,
              label: neighbour.properties['entity_id'] ? neighbour.properties['entity_id'] : neighbour.labels.join(', ')
            })
          }
        }
      }
    } catch (error) {
      console.error('Error refining node properties:', error)
    }
  }

  return {
    ...node,
    relationships
  }
}

const refineEdgeProperties = (edge: RawEdgeType): EdgeType => {
  const state = useGraphStore.getState()
  let sourceNode: RawNodeType | undefined = undefined
  let targetNode: RawNodeType | undefined = undefined

  if (state.sigmaGraph && state.rawGraph) {
    try {
      if (!state.sigmaGraph.hasEdge(edge.dynamicId)) {
        console.warn('Edge not found in sigmaGraph:', edge.id, 'dynamicId:', edge.dynamicId)
        return {
          ...edge,
          sourceNode: undefined,
          targetNode: undefined
        }
      }

      if (state.sigmaGraph.hasNode(edge.source)) {
        sourceNode = state.rawGraph.getNode(edge.source)
      }

      if (state.sigmaGraph.hasNode(edge.target)) {
        targetNode = state.rawGraph.getNode(edge.target)
      }
    } catch (error) {
      console.error('Error refining edge properties:', error)
    }
  }

  return {
    ...edge,
    sourceNode,
    targetNode
  }
}

const PropertyRow = ({
  name,
  value,
  onClick,
  tooltip,
  nodeId,
  edgeId,
  dynamicId,
  entityId,
  entityType,
  sourceId,
  targetId,
  isEditable = false,
  truncate
}: {
  name: string
  value: any
  onClick?: () => void
  tooltip?: string
  nodeId?: string
  entityId?: string
  edgeId?: string
  dynamicId?: string
  entityType?: 'node' | 'edge'
  sourceId?: string
  targetId?: string
  isEditable?: boolean
  truncate?: string
}) => {
  const { t } = useTranslation()

  const getPropertyNameTranslation = (name: string) => {
    const translationKey = `graphPanel.propertiesView.node.propertyNames.${name}`
    const translation = t(translationKey)
    return translation === translationKey ? name : translation
  }

  // Utility function to convert <SEP> to newlines
  const formatValueWithSeparators = (value: any): string => {
    if (typeof value === 'string') {
      return value.replace(/<SEP>/g, ';\n')
    }
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }

  // Format the value to convert <SEP> to newlines
  const formattedValue = formatValueWithSeparators(value)
  let formattedTooltip = tooltip || formatValueWithSeparators(value)

  // If this is source_id field and truncate info exists, append it to the tooltip
  if (name === 'source_id' && truncate) {
    formattedTooltip += `\n(Truncated: ${truncate})`
  }

  // Use EditablePropertyRow for editable fields (description, entity_id and entity_type)
  if (isEditable && (name === 'description' || name === 'entity_id' || name === 'entity_type'  || name === 'keywords')) {
    return (
      <EditablePropertyRow
        name={name}
        value={value}
        onClick={onClick}
        nodeId={nodeId}
        entityId={entityId}
        edgeId={edgeId}
        dynamicId={dynamicId}
        entityType={entityType}
        sourceId={sourceId}
        targetId={targetId}
        isEditable={true}
        tooltip={tooltip || (typeof value === 'string' ? value : JSON.stringify(value, null, 2))}
      />
    )
  }

  // For non-editable fields, use the regular Text component
  return (
    <div className="flex items-start gap-2 rounded-xl px-1 py-1">
      <span className="min-w-[5rem] whitespace-nowrap text-[11px] font-semibold tracking-[0.08em] text-[#8a847e] uppercase dark:text-white/50">
        {getPropertyNameTranslation(name)}
        {name === 'source_id' && truncate && <sup className="text-red-500">†</sup>}
      </span>:
      <Text
        className="min-w-0 flex-1 overflow-hidden rounded-xl px-2 py-1 text-ellipsis text-[#31302e] hover:bg-black/4 dark:text-white/85 dark:hover:bg-white/8"
        tooltipClassName="max-w-96 -translate-x-13"
        text={formattedValue}
        tooltip={formattedTooltip}
        side="left"
        onClick={onClick}
      />
    </div>
  )
}

const NodePropertiesView = ({ node }: { node: NodeType }) => {
  const { t } = useTranslation()
  const sectionClassName =
    'max-h-80 overflow-auto rounded-2xl border border-black/8 bg-[#faf8f5] p-2 dark:border-white/8 dark:bg-white/4'
  const actionButtonClassName =
    'h-8 w-8 rounded-xl border border-black/10 bg-white text-[#766f69] hover:bg-[#f6f5f4] hover:text-[#1f1e1c] dark:border-white/10 dark:bg-white/8 dark:text-white/70 dark:hover:bg-white/12 dark:hover:text-white'

  const handleExpandNode = () => {
    useGraphStore.getState().triggerNodeExpand(node.id)
  }

  const handlePruneNode = () => {
    useGraphStore.getState().triggerNodePrune(node.id)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <h3 className="pl-1 text-[13px] font-semibold tracking-[0.12em] text-[#097fe8] uppercase">{t('graphPanel.propertiesView.node.title')}</h3>
        <div className="flex gap-3">
          <Button
            size="icon"
            variant="ghost"
            className={actionButtonClassName}
            onClick={handleExpandNode}
            tooltip={t('graphPanel.propertiesView.node.expandNode')}
          >
            <GitBranchPlus className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={actionButtonClassName}
            onClick={handlePruneNode}
            tooltip={t('graphPanel.propertiesView.node.pruneNode')}
          >
            <Scissors className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className={sectionClassName}>
        <PropertyRow name={t('graphPanel.propertiesView.node.id')} value={String(node.id)} />
        <PropertyRow
          name={t('graphPanel.propertiesView.node.labels')}
          value={node.labels.join(', ')}
          onClick={() => {
            useGraphStore.getState().setSelectedNode(node.id, true)
          }}
        />
        <PropertyRow name={t('graphPanel.propertiesView.node.degree')} value={node.degree} />
      </div>
      <h3 className="pl-1 text-[13px] font-semibold tracking-[0.12em] text-[#8a847e] uppercase dark:text-white/55">{t('graphPanel.propertiesView.node.properties')}</h3>
      <div className={sectionClassName}>
        {Object.keys(node.properties)
          .sort()
          .map((name) => {
            if (name === 'created_at' || name === 'truncate') return null; // Hide created_at and truncate properties
            return (
              <PropertyRow
                key={name}
                name={name}
                value={node.properties[name]}
                nodeId={String(node.id)}
                entityId={node.properties['entity_id']}
                entityType="node"
                isEditable={name === 'description' || name === 'entity_id' || name === 'entity_type'}
                truncate={node.properties['truncate']}
              />
            )
          })}
      </div>
      {node.relationships.length > 0 && (
        <>
          <h3 className="pl-1 text-[13px] font-semibold tracking-[0.12em] text-[#2a9d99] uppercase">
            {t('graphPanel.propertiesView.node.relationships')}
          </h3>
          <div className={sectionClassName}>
            {node.relationships.map(({ type, id, label }) => {
              return (
                <PropertyRow
                  key={id}
                  name={type}
                  value={label}
                  onClick={() => {
                    useGraphStore.getState().setSelectedNode(id, true)
                  }}
                />
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const EdgePropertiesView = ({ edge }: { edge: EdgeType }) => {
  const { t } = useTranslation()
  const sectionClassName =
    'max-h-80 overflow-auto rounded-2xl border border-black/8 bg-[#faf8f5] p-2 dark:border-white/8 dark:bg-white/4'
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pl-1 text-[13px] font-semibold tracking-[0.12em] text-[#391c57] uppercase dark:text-[#c58dff]">{t('graphPanel.propertiesView.edge.title')}</h3>
      <div className={sectionClassName}>
        <PropertyRow name={t('graphPanel.propertiesView.edge.id')} value={edge.id} />
        {edge.type && <PropertyRow name={t('graphPanel.propertiesView.edge.type')} value={edge.type} />}
        <PropertyRow
          name={t('graphPanel.propertiesView.edge.source')}
          value={edge.sourceNode ? edge.sourceNode.labels.join(', ') : edge.source}
          onClick={() => {
            useGraphStore.getState().setSelectedNode(edge.source, true)
          }}
        />
        <PropertyRow
          name={t('graphPanel.propertiesView.edge.target')}
          value={edge.targetNode ? edge.targetNode.labels.join(', ') : edge.target}
          onClick={() => {
            useGraphStore.getState().setSelectedNode(edge.target, true)
          }}
        />
      </div>
      <h3 className="pl-1 text-[13px] font-semibold tracking-[0.12em] text-[#8a847e] uppercase dark:text-white/55">{t('graphPanel.propertiesView.edge.properties')}</h3>
      <div className={sectionClassName}>
        {Object.keys(edge.properties)
          .sort()
          .map((name) => {
            if (name === 'created_at' || name === 'truncate') return null; // Hide created_at and truncate properties
            return (
              <PropertyRow
                key={name}
                name={name}
                value={edge.properties[name]}
                edgeId={String(edge.id)}
                dynamicId={String(edge.dynamicId)}
                entityType="edge"
                sourceId={edge.sourceNode?.properties['entity_id'] || edge.source}
                targetId={edge.targetNode?.properties['entity_id'] || edge.target}
                isEditable={name === 'description' || name === 'keywords'}
                truncate={edge.properties['truncate']}
              />
            )
          })}
      </div>
    </div>
  )
}

export default PropertiesView
