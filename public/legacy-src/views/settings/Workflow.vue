<template>
  <main class="main-content">
    <div class="row">
      <div class="col-3">
        <div class="card toolbox">
          <div class="card-header"><h5>ابزار ها</h5></div>
          <div class="card-body text-center">
            <button type="button" @click="$refs.chart.add({id: +new Date(), x: 10, y: 10, name: 'New', type: 'operation', approvers: []})">اضافه</button>
            <button type="button" @click="$refs.chart.remove()">حذف</button>
            <button type="button" @click="$refs.chart.editCurrent()">ویرایش</button>
            <button type="button" @click="$refs.chart.save()">ذخیره</button>
          </div>
        </div>
      </div>
      <div class="col-9">
        <div class="card drawbox">
          <div class="card-body p-1" dir="ltr">
            <flowchart
                :nodes="nodes"
                :connections="connections"
                @editnode="handleEditNode"
                :width="'100%'"
                :height="'100%'"
                :readonly="false"
                @dblclick="handleDblClick"
                @editconnection="handleEditConnection"
                @save="handleChartSave"
                ref="chart"
            ></flowchart>
            <connection-dialog :visible.sync="connectionDialogVisible" :connection.sync="connectionForm.target" :operation="connectionForm.operation"></connection-dialog>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
<script>
import ConnectionDialog from "../../components/flowchart/ConnectionDialog";
import Flowchart from "../../components/flowchart/base/Flowchart";
export default {
  components: {
    ConnectionDialog,
    Flowchart
  },
  data(){return{
    nodes: [
      {id: 1, x: 340, y: 270, name: 'Start', type: 'start'},
      {id: 2, x: 740, y: 270, name: 'End', type: 'end', description: 'من اینجام'},
    ],
    connections: [
      {
        source: {id: 1, position: 'right'},
        destination: {id: 2, position: 'left'},
        id: 1,
        type: 'pass',
      },
    ],
    connectionForm: { target: null, operation: null },
    connectionDialogVisible: false,
  }},
  methods: {
    handleChartSave(nodes, connections) {
      // axios.post(url, {nodes, connections}).then(resp => {
      //   this.nodes = resp.data.nodes;
      //   this.connections = resp.data.connections;
      //   // Flowchart will refresh after this.nodes and this.connections changed
      // });
    },
    handleEditNode(node) {
      if (node.id === 2) {
        console.log(node.description);
      }
    },
    handleEditConnection(connection) {
      this.connectionForm.target = connection;
      this.connectionDialogVisible = true;
      setTimeout(function (){
        $('#Flowchart-Modal').modal('show');
      }, 100);
    },
    handleDblClick(position) {
      this.$refs.chart.add({
        id: +new Date(),
        x: position.x,
        y: position.y,
        name: 'New',
        type: 'operation',
        approvers: [],
      });
    },
  }
}
</script>
<style>
.drawbox, .toolbox{height: 89vh;margin-bottom: 0;}
main.main-content{padding-bottom: 0;}
#drawflow{height: 100%;}
</style>