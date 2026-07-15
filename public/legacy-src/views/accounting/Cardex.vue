<template>
  <main class="main-content">
    <div class="card overflow-hidden">
      <div class="page-header page-header-cover p-t-b-40" data-backround-image="/admin/assets/media/image/image1.png">
        <div class="container">
          <div class="row d-flex justify-content-center">
            <div class="col-md-6">
              <h2 class="mb-4 text-white text-center">کاردکس کالا</h2>
              <div class="input-group mb-3">
                <select id="ItemDesc"></select>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="step!='none'" class="card-body">
        <div v-if="step=='loading'" class="text-center text-muted">
          <i class="fa fa-4x fa-refresh fa-spin"></i>
        </div>
        <template v-else>
          <div class="table-responsive">
            <table class="table table-hover">
              <thead>
              <tr>
                <th>نام کالا</th>
                <th>موجودی انبار</th>
                <th>قیمت پایه</th>
                <th>نام انبار</th>
                <th>کد کالا</th>
              </tr>
              </thead>
              <tbody>
              <tr v-for="item of orderItems">
                <td>{{ item.ItemDesc }}</td>
                <td>{{ item.RemainQ }}</td>
                <td>{{ number_format( Math.trunc(item.Price) ) }}</td>
                <td>{{ item.STNumber }} - {{ item.StDesc }}</td>
                <td>{{ item.ItemCode }}</td>
              </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
      <div class="card-footer d-flex justify-content-between">
        <button v-if="st_selected" class="btn btn-info" :data-itemid="orderInfo.ItemId" data-toggle="modal" data-target="#cardex">کاردکس کالا</button><span v-else></span>
      </div>
    </div>
    <modal-cardex />
  </main>
</template>
<script>
import util from "../../assets/pureFunctions.js";
import axios from "axios";
import ModalCardex from "../../components/ModalCardex";

export default {
  data(){return {
    step: "none",
    orderId: "",
    orderItems: [],
    orderInfo: {},
    orderItemsCount: 0,
    number_format: util.number_format,
    st_selected: false,
    mdEl: null
  }},
  methods:{
    statusTranslate(id){
      switch (id){
        case 2: return "فاکتور فروش";
        case 3: return "فاکتور خرید";
        case 5: return "رسید انبار";
        case 4: return "حواله انبار";
        case 6: return "برگشت از فروش";
        case 7: return "برگشت از خرید";
        default: return id;
      }
    },
    getStockItems(id){
      const vm = this;
      this.step = "loading";
      axios.post('https://shygun.4mk.ir/api/stock/search', {name: id}).then(({data}) => {
        this.step = "done";
        if( data && data.ok ){
          this.orderItems = data.list;
        }else{
          toastr['error']("خطایی در فراخوانی داده ها رخ داده است.");
          this.orderId = '';
          this.step = "none";
        }
      });
    }
  },
  mounted() {
    const vm = this;
    if( this.$route.params.id ){
      this.orderId = this.$route.params.id;
    }
    $(document).ready(function(){
      $('#ItemDesc').select2({
        placeholder: "قسمتی از نام کالا را وارد کنید ...",
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/productName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.ItemDesc,
                    id: item.ItemCode,
                    ItemId: item.ItemId
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });
      $('#ItemDesc').select2('open');
      $('#ItemDesc').on('select2:select', function (e) {
        var data = e.params.data;
        vm.getStockItems(data.id);
        vm.orderInfo.ItemId = data.ItemId;
        vm.st_selected = true;
      });

    });
  },
  components: {
    "modal-cardex": ModalCardex
  }
}
</script>
<style scoped>
.card-img-right{width: 100px; height: 100px; margin-left: 5px;}
.small-descr{font-size: 11px;line-height: 16px;margin-bottom: 0;}
.b-q{font-family: Arial; font-weight: bold;}
.p-descr{
  margin-bottom: 1.5rem;
  min-height: 110px;
}
.footer-items{
  display: flex;
  flex-direction: row-reverse;
  position: absolute;
  bottom: 5px;
  left: 10px;
}
.customer-info .form-group{margin-bottom: 0; padding-bottom: 10px;border-bottom: 1px solid rgba(0,0,0,.125)}
.customer-info .form-group:nth-child(odd){
  border-left: 1px solid rgba(0,0,0,.125);
}
.customer-info .form-group:nth-last-child(1),
.customer-info .form-group:nth-last-child(2){border-bottom: none;}
.bg-success .text-success{color: #FFF !important;}
main.main-content {
  min-height: 500px;
}
.fa-large{
  font-size: 20px;
  cursor: pointer;
}
</style>
