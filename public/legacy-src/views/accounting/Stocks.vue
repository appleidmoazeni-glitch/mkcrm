<template>
  <main class="main-content">
    <div class="card overflow-hidden">
      <div class="page-header page-header-cover p-t-b-40" data-backround-image="/admin/assets/media/image/image1.png">
        <div class="container">
          <h2 class="mb-4 text-white text-center">موجودی انبارها</h2>
          <div class="row">
            <div class="col-lg-12 p-l-r-50">
              <div class="row">
                <div class="col-lg-6 mb-2">
                  <input v-model="orderId" @keypress.enter="getOrderItems(orderId)" type="text" class="form-control" aria-label="Example text with button addon" placeholder="قسمتی از نام کالا را وارد نمایید ..." aria-describedby="button-addon1">
                </div>
                <div class="col-lg-6 mb-2">
                  <select class="form-control" id="stock" data-module="select2" multiple data-placeholder="انبار"></select>
                </div>

                <div class="col-lg-6 mb-2">
                  <select class="form-control" id="group" data-module="select2" multiple></select>
                </div>
                <div class="col-lg-6 mb-2">
                  <select class="form-control" id="sub-group" data-module="select2" multiple></select>
                </div>
              </div>

              <div class="row text-center mt-4">
                <div class="col-12">
                  <button @click="getOrderItems(orderId)" class="btn btn-warning p-l-r-50" type="button" id="button-addon1"><i class="ti-search ml-2"></i><span>جستجوی کالا</span></button>
                </div>
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
                <th width="60">کاردکس</th>
                <th>نام کالا</th>
                <th>موجودی انبار</th>
                <th>قیمت پایه</th>
                <th>نام انبار</th>
                <th>کد کالا</th>
                <th>سریال کالا</th>
              </tr>
              </thead>
              <tbody>
              <tr v-for="item of orderItems">
                <td><i data-toggle="modal" :data-itemid="item.ItemId" data-target="#cardex" class="fa fa-info-circle text-info fa-large"></i></td>
                <td>{{ item.ItemDesc }}</td>
                <td>{{ item.RemainQ }}</td>
                <td>{{ number_format( Math.trunc(item.Price) ) }}</td>
                <td>{{ item.STNumber }} - {{ item.StDesc }}</td>
                <td>{{ item.ItemCode }}</td>
                <td></td>
              </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <modal-cardex />

    <p class="text-muted"><span class="text-danger">* نکته:</span> برای جستجو همه کالا یک دسته یا گروه کالا، از کاراکتر ستاره (*) استفاده نمایید.</p>
  </main>
</template>
<script>
import util from "../../assets/pureFunctions.js";
import axios from "axios";
import modalCardex from "../../components/ModalCardex";

export default {
  data(){return {
    step: "none",
    orderId: "",
    orderItems: [],
    orderInfo: {},
    orderItemsCount: 0,
    number_format: util.number_format,
    st_selected: false
  }},
  methods:{
    getOrderItems(id){
      if( id ){
        this.step = "loading";
        let dataSet = {name: id};
        let stocks = $("#stock").val().join(',');
        let itemGroup = $("#group").val().concat($("#sub-group").val()).join(',');
        if( stocks ){
          dataSet.stocks = stocks;
        }
        if( itemGroup ){
          dataSet.itemgroup = itemGroup;
        }
        axios.post('https://shygun.4mk.ir/api/stock/search', dataSet).then(({data}) => {
          this.step = "done";
          if( data && data.ok ){
            this.orderItems = data.list;
          }else{
            toastr['error']("خطایی در فراخوانی داده ها رخ داده است.");
            this.orderId = '';
            this.step = "none";
          }
        });
      }else{
        toastr['error']("وارد کردن نام کالا الزامی است.");
      }
    }
  },
  mounted() {
    const vm = this;
    if( this.$route.params.id ){
      this.orderId = this.$route.params.id;
      this.getOrderItems(this.orderId);
    }

    $(document).ready(function(){
      $('#group').select2({
        placeholder: "گروه کالا",
        minimumInputLength: 2,
        ajax: {
          url: 'https://shygun.4mk.ir/api/categories/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term,
              type: 1
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.GroupName + (item.GroupNumber == item.GroupId? "" : (" (" + item.GroupNumber + ")")),
                    id: item.GroupId
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#group').on('select2:select', function (e) {
        var data = e.params.data;
      });

      $('#sub-group').select2({
        placeholder: "زیر گروه کالا",
        minimumInputLength: 2,
        ajax: {
          url: 'https://shygun.4mk.ir/api/categories/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term,
              type: 0
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.GroupName + (item.GroupNumber == item.GroupId? "" : (" (" + item.GroupNumber + ")")),
                    id: item.GroupId
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#sub-group').on('select2:select', function (e) {
        var data = e.params.data;
      });

      $('#stock').select2({
        placeholder: "انبار",
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/stockName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.StDesc + " (" + item.STNumber + ")",
                    id: item.STNumber
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#stock').on('select2:select', function (e) {
        var data = e.params.data;
      });
    });
  },
  components: {
    'modal-cardex': modalCardex,
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
<style>
.select2-container--default .select2-selection--multiple .select2-selection__choice {
  background-color: #0498bb;
}
.select2-container--default .select2-selection--multiple .select2-selection__choice__remove {
  color: #125f72;
}
#cardex .modal-body {
  height: calc(100vh - 118px);
  overflow-y: scroll;
}
</style>
